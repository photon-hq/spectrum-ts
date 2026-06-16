import { defineConfig } from "tsdown";

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
  format: "esm",
  fixedExtension: false,
  dts: true,
  clean: true,
  platform: "node",
  // Everything this package exposes is a re-export of a sibling `@spectrum-ts/*`
  // package — keep them external so the metapackage stays a thin shell (and the
  // shims fail loudly at resolution if a provider isn't installed).
  external: [/^@spectrum-ts\//],
});
