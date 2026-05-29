import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "esnext",
  // spectrum-ts and zod are peer dependencies (zod must be the same instance
  // spectrum-ts parses with); @linqapp/sdk is a runtime dependency. Never
  // bundle any of them — including subpaths like spectrum-ts/authoring.
  external: [/^spectrum-ts(\/|$)/, /^@linqapp\/sdk(\/|$)/, "zod"],
});
