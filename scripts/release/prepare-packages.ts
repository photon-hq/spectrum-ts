#!/usr/bin/env bun
/**
 * Pre-publish packaging: copies the repo-root LICENSE into every publishable
 * package directory (npm includes LICENSE/README in the tarball regardless of
 * `files`) and asserts each has a committed README.md. The core additionally
 * receives the root README via its own prepare-package.ts during build.
 */

import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { file } from "bun";
import { publishablePackages, REPO_ROOT } from "./packages";

const pkgs = await publishablePackages();
for (const pkg of pkgs) {
  await copyFile(join(REPO_ROOT, "LICENSE"), join(pkg.dir, "LICENSE"));
  const readme = file(join(pkg.dir, "README.md"));
  if (!(await readme.exists())) {
    console.error(`✗ ${pkg.json.name}: missing README.md in ${pkg.dir}`);
    process.exit(1);
  }
}
console.log(`✓ LICENSE copied + README present for ${pkgs.length} packages`);
