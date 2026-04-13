import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "providers/imessage/index": "src/providers/imessage/index.ts",
    "providers/terminal/index": "src/providers/terminal/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "esnext",
});
