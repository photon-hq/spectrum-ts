import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    authoring: "src/authoring.ts",
    elysia: "src/elysia.ts",
    express: "src/express.ts",
    hono: "src/hono.ts",
    "providers/index": "src/providers/index.ts",
    "providers/imessage/index": "src/providers/imessage/index.ts",
    "providers/slack/index": "src/providers/slack/index.ts",
    "providers/telegram/index": "src/providers/telegram/index.ts",
    "providers/terminal/index": "src/providers/terminal/index.ts",
    "providers/whatsapp-business/index":
      "src/providers/whatsapp-business/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "esnext",
  external: ["elysia", "express", "hono", "ffmpeg-static"],
  // esbuild bundles CommonJS dependencies (e.g. `vcf`, `mime-types`) into
  // this ESM output and rewrites their `require(...)` calls to a `__require` shim
  // whose fallback throws `Dynamic require of "x" is not supported` — because
  // `require` is undefined in a real ESM context. Injecting a `createRequire`
  // banner into every emitted file restores a working `require`, so that shim
  // delegates to it instead of throwing at import time under Node.
  banner: {
    js: 'import { createRequire as __spectrumCreateRequire } from "node:module"; const require = __spectrumCreateRequire(import.meta.url);',
  },
});
