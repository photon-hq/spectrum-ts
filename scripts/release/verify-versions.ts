#!/usr/bin/env bun
/**
 * Pre-publish invariants, run by the release workflow after the bump commit
 * is checked out:
 *
 * 1. Lockstep: every publishable package.json#version equals the release
 *    version (argv[2], optional — skipped for publish-only resumes).
 * 2. No `workspace:` or `catalog:` ranges outside devDependencies in any
 *    publishable package: clean-publish/npm do not rewrite them (only
 *    `bun publish` does, which we don't use), so they must never reach a
 *    published manifest. devDependencies are stripped by clean-publish.
 * 3. Providers' `spectrum-ts` peer range matches the release version.
 */

import { CORE_NAME, publishablePackages } from "./packages";

const expected = process.argv[2];
const errors: string[] = [];
const pkgs = await publishablePackages();

for (const pkg of pkgs) {
  const { name, version } = pkg.json;
  if (expected && version !== expected) {
    errors.push(`${name}: version ${version} != expected ${expected}`);
  }
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    for (const [dep, range] of Object.entries(pkg.json[field] ?? {})) {
      if (range.startsWith("workspace:") || range.startsWith("catalog:")) {
        errors.push(
          `${name}: ${field}.${dep} = "${range}" would ship unresolved to npm`
        );
      }
    }
  }
  const peer = pkg.json.peerDependencies?.[CORE_NAME];
  if (name !== CORE_NAME && expected) {
    if (peer) {
      // Mirror bump-version: a prerelease pins the exact version (a caret
      // range would not satisfy `5.0.0-rc.1` under semver); a stable release
      // uses `^<major>.0.0`.
      const expectedPeer = expected.includes("-")
        ? expected
        : `^${expected.split(".")[0]}.0.0`;
      if (peer !== expectedPeer) {
        errors.push(
          `${name}: peerDependencies.${CORE_NAME} = "${peer}" does not match expected "${expectedPeer}"`
        );
      }
    } else {
      errors.push(`${name}: missing peerDependencies.${CORE_NAME}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ ${pkgs.length} packages verified${expected ? ` at ${expected}` : ""}`
);
