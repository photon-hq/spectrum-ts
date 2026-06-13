#!/usr/bin/env node
/**
 * Build smoke test: import a freshly built ESM bundle under Node — the exact
 * environment a published consumer (and the sidecar) uses via the package's
 * `default` export condition.
 *
 * This guards against the bundle throwing at import time, e.g. when the
 * bundler inlines a CommonJS dependency and its rewritten `require(...)` hits
 * the `Dynamic require of "x" is not supported` shim. Such a bundle imports
 * fine under Bun (which resolves the `bun` condition to TS source) but is dead
 * on Node — so it must run under Node here, after the bundler, to be
 * meaningful. For provider packages it additionally proves Node resolves the
 * workspace `spectrum-ts` peer through its `default` condition.
 *
 * Usage: node smoke-import.mjs <entry> — entry resolved from the calling
 * package's cwd, e.g. `node ../../scripts/smoke-import.mjs dist/index.js`.
 * Runs as part of each package's `build`; exits non-zero to fail the build.
 */

import { resolve } from "node:path";
import { cwd, exit } from "node:process";
import { pathToFileURL } from "node:url";

const entryArg = process.argv[2];
if (!entryArg) {
  console.error("usage: smoke-import.mjs <entry> (path relative to cwd)");
  exit(1);
}
// Dynamic import() needs a file:// URL for an absolute path — a bare absolute
// path fails on Windows (the drive letter parses as a URL scheme).
const ENTRY = pathToFileURL(resolve(cwd(), entryArg)).href;

try {
  const mod = await import(ENTRY);
  const exportCount = Object.keys(mod).length;
  if (exportCount === 0) {
    throw new Error("bundle imported but exported nothing");
  }
  console.log(
    `✓ smoke: ${entryArg} imports under Node (${exportCount} exports)`
  );
} catch (error) {
  console.error(`✗ smoke: ${entryArg} failed to import under Node`);
  console.error(error);
  exit(1);
}
