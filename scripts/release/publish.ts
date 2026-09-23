#!/usr/bin/env bun
/**
 * Sequential, idempotent npm publish loop over all publishable packages,
 * core first (providers peer-range the core, so it must exist on the
 * registry before they do).
 *
 * Per package:
 * 1. Skip if name@version is already on the registry — makes a partially
 *    failed release resumable by simply re-running (or dispatching the
 *    workflow with publish-only).
 * 2. `bunx clean-publish --package-manager npm` — applies
 *    publishConfig.exports (dist-only map), strips scripts/devDependencies
 *    (including the workspace:* dev dep on core), then `npm publish`es the
 *    cleaned copy. Attempt 1 runs tokenless with `-- --provenance` (npm OIDC
 *    trusted publishing — requires the job's id-token: write and a trusted
 *    publisher per package on npmjs.com; oidc-preflight.ts verifies that
 *    up-front). npm only reports OIDC failures at `--loglevel verbose` and
 *    otherwise surfaces them as a bare `E404`, so attempt 1 runs verbose and
 *    its `oidc` lines are echoed on failure. On failure it retries with
 *    NPM_TOKEN and emits a workflow warning: that path is deprecated (npm
 *    removes direct publish for 2FA-bypass tokens around Jan 2027) and is
 *    only legitimately needed for the first-ever publish of a new package
 *    name (trusted publishers can't exist for unpublished names).
 * 3. Grep the captured output for npm errors even on exit 0 — clean-publish
 *    has historically swallowed npm publish failures (spectrum-ts
 *    1.10.0–1.11.1 silently never reached npm).
 * 4. Poll the registry until the exact version is visible.
 *
 * Usage: publish.ts --tag <latest|beta> [--dry-run]
 */

import { sleep, spawn } from "bun";
import { type PublishablePackage, publishablePackages } from "./packages";

const args = process.argv.slice(2);
const tag = args[args.indexOf("--tag") + 1];
const dryRun = args.includes("--dry-run");
if (!tag || tag.startsWith("--")) {
  console.error("usage: publish.ts --tag <dist-tag> [--dry-run]");
  process.exit(1);
}

const NPM_ERROR_RE = /^npm (error|ERR!)/m;
// npm's trusted-publishing diagnostics ("npm verbose oidc …"). Echoed when the
// OIDC attempt fails so the real reason isn't buried under a generic E404.
const NPM_OIDC_LINE_RE = /^npm (verbose|silly|http) .*oidc/im;
// Everything npm prints at levels below `notice` — dropped from a successful
// verbose run so the happy path stays readable.
const NPM_CHATTER_RE = /^npm (verbose|silly|http|info) /;
const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 15_000;

// Bounded registry probe. A timeout or transient network error reads as
// "not present", which is safe at both call sites: the pre-publish skip
// check falls through to a publish attempt (idempotent — an
// already-published version is rejected by npm and surfaced), and the
// post-publish verifier just keeps retrying.
async function registryHas(name: string, version: string): Promise<boolean> {
  try {
    const res = await fetch(`${REGISTRY}/${name}/${version}`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch (error) {
    console.warn(
      `  registry probe for ${name}@${version} failed: ${error instanceof Error ? error.message : error}`
    );
    return false;
  }
}

// ~10min budget. By the time this runs npm has already answered
// `+ name@version` — the publish succeeded — so not seeing the version yet only
// means registry propagation is lagging. Provenance publishes now go through
// async processing ("Your package is being processed and may take a few
// minutes to become available"); the previous 2min budget expired ~1.5s before
// @spectrum-ts/express@12.10.1 appeared and aborted the release with the
// metapackage still unpublished. On timeout, warn and continue rather than
// throw: the remaining packages only need the registry to catch up, and a
// stale peer range surfaces on install, not on publish.
const REGISTRY_VISIBILITY_ATTEMPTS = 120;
const REGISTRY_VISIBILITY_DELAY_MS = 5000;

async function verifyOnRegistry(
  name: string,
  version: string,
  attempts = REGISTRY_VISIBILITY_ATTEMPTS,
  delayMs = REGISTRY_VISIBILITY_DELAY_MS
): Promise<void> {
  const started = Date.now();
  for (let i = 0; i < attempts; i++) {
    if (await registryHas(name, version)) {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(
        `  ✓ ${name}@${version} visible on registry (after ${seconds}s)`
      );
      return;
    }
    await sleep(delayMs);
  }
  const minutes = Math.round((attempts * delayMs) / 60_000);
  console.log(
    `::warning::${name}@${version} was accepted by npm but is still not visible on the registry after ${minutes}min; continuing — check https://www.npmjs.com/package/${name} before announcing the release.`
  );
}

async function runPublishAttempt(
  pkg: PublishablePackage,
  oidc: boolean
): Promise<{ ok: boolean; output: string }> {
  const cmd = [
    "bunx",
    "clean-publish",
    "--package-manager",
    "npm",
    "--access",
    "public",
    "--tag",
    tag,
  ];
  // Flags meant for `npm publish` itself go after `--`: clean-publish treats
  // any flag it doesn't know (e.g. a bare `--provenance`) as its positional
  // argument and drops it. `--dry-run` rides along here too rather than as a
  // clean-publish flag, because clean-publish 7.1.0's `--dry-run` parser
  // consumes the following argument — which would eat the `--` itself.
  const npmOptions: string[] = [];
  if (oidc) {
    npmOptions.push("--provenance");
  }
  if (dryRun) {
    npmOptions.push("--dry-run");
  }
  if (npmOptions.length > 0) {
    cmd.push("--", ...npmOptions);
  }
  const env: Record<string, string | undefined> = { ...process.env };
  if (oidc) {
    // Tokenless: npm >= 11.5.1 exchanges the Actions OIDC token itself.
    env.NODE_AUTH_TOKEN = undefined;
    env.npm_config__authToken = undefined;
    // The only level at which npm explains an OIDC failure.
    env.npm_config_loglevel = "verbose";
  } else {
    env.NODE_AUTH_TOKEN = process.env.NPM_TOKEN;
  }
  const proc = spawn(cmd, {
    cwd: pkg.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const output = `${stdout}\n${stderr}`;
  const ok = exitCode === 0 && !NPM_ERROR_RE.test(output);
  if (oidc && ok) {
    process.stdout.write(
      `${output
        .split("\n")
        .filter((line) => !NPM_CHATTER_RE.test(line))
        .join("\n")}\n`
    );
  } else {
    process.stdout.write(output);
  }
  return { ok, output };
}

// Pull npm's own explanation of why trusted publishing didn't happen out of a
// failed verbose run (e.g. "Failed token exchange request with body message:
// …", "Skipped because incorrect permissions for id-token …").
function oidcDiagnostics(output: string): string[] {
  return output.split("\n").filter((line) => NPM_OIDC_LINE_RE.test(line));
}

const pkgs = await publishablePackages();
console.log(
  `Publishing ${pkgs.length} packages (tag: ${tag}${dryRun ? ", dry-run" : ""})`
);

for (const pkg of pkgs) {
  const { name, version } = pkg.json;
  if (!dryRun && (await registryHas(name, version))) {
    console.log(`• skip ${name}@${version} (already published)`);
    continue;
  }
  console.log(`• publish ${name}@${version} from ${pkg.dir}`);
  let result = await runPublishAttempt(pkg, true);
  if (!result.ok) {
    const diagnostics = oidcDiagnostics(result.output);
    console.log(`  OIDC attempt failed for ${name} — npm's reason:`);
    for (const line of diagnostics.length > 0
      ? diagnostics
      : ["    (npm printed no oidc diagnostics)"]) {
      console.log(`    ${line}`);
    }
    console.log(
      `::warning::${name}@${version}: trusted publishing (OIDC) failed; falling back to NPM_TOKEN. Fix the trusted publisher on npmjs.com — the token path is deprecated.`
    );
    result = await runPublishAttempt(pkg, false);
  }
  if (!result.ok) {
    console.error(`✗ ${name}@${version} failed to publish`);
    process.exit(1);
  }
  if (!dryRun) {
    await verifyOnRegistry(name, version);
  }
}
console.log("✓ all packages published");
