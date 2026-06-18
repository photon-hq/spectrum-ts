#!/usr/bin/env bun
/**
 * Lockstep version bump: sets every publishable package to the given version
 * and rewrites the internal `@spectrum-ts/*` dependency ranges to match.
 *
 * - A provider's `peerDependencies["@spectrum-ts/core"]` gets a caret range
 *   on the current major (`^5.0.0`) so runtime patches don't force provider
 *   re-releases. Prereleases get an exact pin instead: `^5.0.0` does NOT match
 *   `5.0.0-rc.1` under semver, so a caret would make rc installs unresolvable.
 * - The `spectrum-ts` metapackage's regular `dependencies` on `@spectrum-ts/*`
 *   are pinned to the exact release version (it ships those exact siblings).
 *
 * Run `bun install` afterwards (the release workflow does) — bun.lock records
 * workspace versions and dependency ranges.
 */

import { writeFile } from "node:fs/promises";
import { publishablePackages } from "./packages";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTERNAL_SCOPE = "@spectrum-ts/";

const version = process.argv[2];
if (!(version && SEMVER_RE.test(version))) {
  console.error("usage: bump-version.ts <semver>");
  process.exit(1);
}

const prerelease = version.includes("-");
const major = version.split(".")[0];
const peerRange = prerelease ? version : `^${major}.0.0`;

const pkgs = await publishablePackages();
for (const pkg of pkgs) {
  pkg.json.version = version;
  // Provider peer ranges on the runtime: caret (or exact for prereleases).
  const peers = pkg.json.peerDependencies;
  if (peers) {
    for (const [dep, range] of Object.entries(peers)) {
      if (dep.startsWith(INTERNAL_SCOPE) && range !== "*") {
        peers[dep] = peerRange;
      }
    }
  }
  // Metapackage regular deps on siblings: exact lockstep version.
  const deps = pkg.json.dependencies;
  if (deps) {
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith(INTERNAL_SCOPE)) {
        deps[dep] = version;
      }
    }
  }
  await writeFile(pkg.path, `${JSON.stringify(pkg.json, null, 2)}\n`);
}

console.log(
  `Bumped ${pkgs.length} packages to ${version} (peer range: ${peerRange})`
);
