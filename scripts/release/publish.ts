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
 *    cleaned copy. Attempt 1 runs tokenless with --provenance (npm OIDC
 *    trusted publishing — requires the job's id-token: write and a trusted
 *    publisher configured on npmjs.com); on failure it retries with
 *    NPM_TOKEN. First-ever publishes of a new package name can only use the
 *    token path (trusted publishers can't exist for unpublished names).
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

// ~2min budget. The publish already succeeded, so a failure here only means
// registry propagation is lagging — poll generously rather than abort an
// otherwise-fine release. Core publishes first, so an early throw would leave
// every provider and the metapackage unpublished.
async function verifyOnRegistry(
  name: string,
  version: string,
  attempts = 24,
  delayMs = 5000
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await registryHas(name, version)) {
      console.log(`  ✓ ${name}@${version} visible on registry`);
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`${name}@${version} not visible on registry after publish`);
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
  if (oidc) {
    cmd.push("--provenance");
  }
  if (dryRun) {
    cmd.push("--dry-run");
  }
  const env: Record<string, string | undefined> = { ...process.env };
  if (oidc) {
    // Tokenless: npm >= 11.5.1 exchanges the Actions OIDC token itself.
    env.NODE_AUTH_TOKEN = undefined;
    env.npm_config__authToken = undefined;
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
  process.stdout.write(output);
  return { ok: exitCode === 0 && !NPM_ERROR_RE.test(output), output };
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
    console.log(`  OIDC attempt failed for ${name} — retrying with NPM_TOKEN`);
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
