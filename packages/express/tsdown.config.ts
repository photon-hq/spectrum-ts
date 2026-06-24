import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  fixedExtension: false,
  dts: true,
  clean: true,
  platform: "node",
});
