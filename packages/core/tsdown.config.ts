import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    authoring: "src/authoring.ts",
  },
  format: "esm",
  fixedExtension: false,
  dts: true,
  clean: true,
  platform: "node",
  external: ["ffmpeg-static"],
});
