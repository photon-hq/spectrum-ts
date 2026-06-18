#!/usr/bin/env bun
/**
 * Validates the artifacts we would publish, in CI, without publishing:
 *
 * For each publishable package, runs `clean-publish --without-publish` to
 * produce the exact cleaned copy that would go to npm (publishConfig.exports
 * applied, scripts/devDependencies stripped), then runs `publint` and
 * `@arethetypeswrong/cli` against THAT copy — the workspace package.json
 * intentionally points `types` at src/ (buildless in-repo DX), which would
 * false-positive both tools.
 *
 * Also asserts no `workspace:`/`catalog:` ranges survived cleaning, and —
 * when SPECTRUM_PUBLISH=1 — that the built core does not ship the
 * development build-env (`SPECTRUM_SDK_VERSION = "local"`), the bug that
 * affected every 4.x release.
 *
 * Requires `bun run build` to have run first (dist/ must exist).
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";
import { CORE_NAME, META_NAME, publishablePackages } from "./packages";

const TEMP = ".clean-publish-tmp";
const errors: string[] = [];

// Recursively list every .js file under a directory. The core build emits
// nested output (dist/providers/<key>/index.js, chunk files), so a top-level
// readdir would miss exactly the artifacts the "local" build-env check must
// scan.
async function listJsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} (in ${cwd}):\n${stdout}\n${stderr}`);
  }
  return stdout;
}

const pkgs = await publishablePackages();
for (const pkg of pkgs) {
  const name = pkg.json.name;
  const cleanedDir = join(pkg.dir, TEMP);
  await rm(cleanedDir, { recursive: true, force: true });
  try {
    await run(
      [
        "bunx",
        "clean-publish",
        "--without-publish",
        "--temp-dir",
        TEMP,
        "--package-manager",
        "npm",
      ],
      pkg.dir
    );

    const cleaned = JSON.parse(
      await readFile(join(cleanedDir, "package.json"), "utf8")
    ) as Record<string, Record<string, string> | undefined>;
    if (cleaned.devDependencies) {
      errors.push(`${name}: devDependencies survived clean-publish`);
    }
    for (const field of ["dependencies", "peerDependencies"] as const) {
      for (const [dep, range] of Object.entries(cleaned[field] ?? {})) {
        if (range.startsWith("workspace:") || range.startsWith("catalog:")) {
          errors.push(`${name}: cleaned ${field}.${dep} = "${range}"`);
        }
      }
    }

    await run(["bunx", "publint", "--strict"], cleanedDir);
    await run(
      ["bunx", "@arethetypeswrong/cli", "--pack", ".", "--profile", "esm-only"],
      cleanedDir
    );
    console.log(`✓ ${name}: clean-publish output passes publint + attw`);
  } catch (error) {
    errors.push(`${name}: ${error instanceof Error ? error.message : error}`);
  } finally {
    await rm(cleanedDir, { recursive: true, force: true });
  }

  if (name === CORE_NAME && process.env.SPECTRUM_PUBLISH === "1") {
    const dist = join(pkg.dir, "dist");
    for (const file of await listJsFiles(dist)) {
      const content = await readFile(file, "utf8");
      if (content.includes('SPECTRUM_SDK_VERSION = "local"')) {
        errors.push(
          `${name}: ${file.replace(`${pkg.dir}/`, "")} ships the development build-env ("local") in a publish build`
        );
      }
    }
  }

  // The metapackage's compat shims (`spectrum-ts/providers/*`) can't be
  // smoke-imported at its BUILD time — the provider packages build after it in
  // the task graph. Here the full build has run, so importing the aggregate
  // barrel under Node proves every shim resolves its provider's dist.
  if (name === META_NAME) {
    try {
      await run(
        ["node", "../../scripts/smoke-import.mjs", "dist/providers/index.js"],
        pkg.dir
      );
      console.log(`✓ ${name}: provider shims resolve under Node`);
    } catch (error) {
      errors.push(
        `${name}: provider shim smoke failed: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${pkgs.length} package artifacts verified`);
