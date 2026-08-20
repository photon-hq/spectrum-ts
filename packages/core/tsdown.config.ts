import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    authoring: "src/authoring.ts",
    webhook: "src/webhook/portable.ts",
  },
  format: "esm",
  fixedExtension: false,
  dts: true,
  clean: true,
  platform: "node",
  external: ["ffmpeg-static"],
});
