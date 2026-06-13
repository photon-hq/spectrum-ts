import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    authoring: "src/authoring.ts",
    internal: "src/internal.ts",
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
  // The provider packages are deliberately NOT in dependencies/peerDependencies
  // (a declared edge gives Turborepo a package-graph cycle), so tsdown would
  // bundle them into core's dist — the regex keeps the shim re-exports
  // external in both JS and d.ts output.
  external: ["ffmpeg-static", /^@photon-ai\/spectrum-provider-/],
});
