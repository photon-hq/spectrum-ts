import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "adapters/vercel-ai-sdk/index": "src/adapters/vercel-ai-sdk/index.ts",
    index: "src/index.ts",
    "providers/index": "src/providers/index.ts",
    "providers/imessage/index": "src/providers/imessage/index.ts",
    "providers/terminal/index": "src/providers/terminal/index.ts",
    "providers/vercel-ai-sdk-ui/index":
      "src/providers/vercel-ai-sdk-ui/index.ts",
    "providers/web-bridge/index": "src/providers/web-bridge/index.ts",
    "providers/whatsapp-business/index":
      "src/providers/whatsapp-business/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "esnext",
  external: ["ai", "ffmpeg-static"],
});
