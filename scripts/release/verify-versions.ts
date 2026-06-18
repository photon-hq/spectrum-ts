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
 * 3. Each provider peer-deps the runtime at the matching range; the
 *    metapackage regular-deps the runtime (and providers) at the exact version.
 */

import { CORE_NAME, META_NAME, publishablePackages } from "./packages";

const INTERNAL_SCOPE = "@spectrum-ts/";

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
  if (!expected) {
    continue;
  }
  // Detect providers by their `@spectrum-ts/*` name (every scoped package
  // except the runtime), NOT the optional `spectrum` manifest key — a provider
  // that forgets that key must still have its core peer range validated rather
  // than silently skipping the check (fail closed, not open).
  if (name.startsWith(INTERNAL_SCOPE) && name !== CORE_NAME) {
    // Provider → runtime is a peer dependency at the matching range.
    const peer = pkg.json.peerDependencies?.[CORE_NAME];
    const expectedPeer = expected.includes("-")
      ? expected
      : `^${expected.split(".")[0]}.0.0`;
    if (!peer) {
      errors.push(`${name}: missing peerDependencies.${CORE_NAME}`);
    } else if (peer !== expectedPeer) {
      errors.push(
        `${name}: peerDependencies.${CORE_NAME} = "${peer}" does not match expected "${expectedPeer}"`
      );
    }
  } else if (name === META_NAME) {
    // Metapackage → siblings are exact-pinned regular dependencies.
    for (const [dep, range] of Object.entries(pkg.json.dependencies ?? {})) {
      if (dep.startsWith(INTERNAL_SCOPE) && range !== expected) {
        errors.push(
          `${name}: dependencies.${dep} = "${range}" is not pinned to ${expected}`
        );
      }
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
