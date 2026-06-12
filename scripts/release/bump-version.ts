#!/usr/bin/env bun
/**
 * Lockstep version bump: sets every publishable package to the given version
 * and rewrites the providers' `spectrum-ts` peer range to match.
 *
 * Stable releases get a caret range on the current major (`^5.0.0`) so core
 * patches don't force provider re-releases. Prereleases get an exact pin:
 * `^5.0.0` does NOT match `5.0.0-rc.1` under semver, so a caret range would
 * make rc installs unresolvable.
 *
 * Run `bun install` afterwards (the release workflow does) — bun.lock records
 * workspace versions and peer ranges.
 */

import { writeFile } from "node:fs/promises";
import { CORE_NAME, publishablePackages } from "./packages";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];
if (!(version && SEMVER_RE.test(version))) {
  console.error("usage: bump-version.ts <semver>");
  process.exit(1);
}

const prerelease = version.includes("-");
const major = version.split(".")[0];
const corePeerRange = prerelease ? version : `^${major}.0.0`;

const pkgs = await publishablePackages();
for (const pkg of pkgs) {
  pkg.json.version = version;
  if (pkg.json.peerDependencies?.[CORE_NAME]) {
    pkg.json.peerDependencies[CORE_NAME] = corePeerRange;
  }
  await writeFile(pkg.path, `${JSON.stringify(pkg.json, null, 2)}\n`);
}

console.log(
  `Bumped ${pkgs.length} packages to ${version} (core peer range: ${corePeerRange})`
);
