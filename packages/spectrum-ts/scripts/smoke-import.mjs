#!/usr/bin/env node
/**
 * Build smoke test: import the freshly built ESM bundle under Node — the exact
 * environment a published consumer (and the sidecar) uses via the package's
 * `default` export condition.
 *
 * This guards against the bundle throwing at import time, e.g. when esbuild
 * inlines a CommonJS dependency and its rewritten `require(...)` hits the
 * `Dynamic require of "x" is not supported` shim. Such a bundle imports fine
 * under Bun (which resolves the `bun` condition to TS source) but is dead on
 * Node — so it must run under Node here, after `tsup`, to be meaningful.
 *
 * Runs as part of `build`; exits non-zero on failure to fail the build.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "dist", "index.js");

try {
  const mod = await import(ENTRY);
  const exportCount = Object.keys(mod).length;
  if (exportCount === 0) {
    throw new Error("bundle imported but exported nothing");
  }
  console.log(
    `✓ smoke: dist/index.js imports under Node (${exportCount} exports)`
  );
} catch (error) {
  console.error("✗ smoke: dist/index.js failed to import under Node");
  console.error(error);
  process.exit(1);
}
