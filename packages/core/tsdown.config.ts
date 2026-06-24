import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    authoring: "src/authoring.ts",
    elysia: "src/elysia.ts",
    express: "src/express.ts",
    hono: "src/hono.ts",
    fastify: "src/fastify.ts",
  },
  format: "esm",
  fixedExtension: false,
  dts: true,
  clean: true,
  platform: "node",
  external: ["ffmpeg-static", "elysia", "express", "hono", "fastify"],
});
