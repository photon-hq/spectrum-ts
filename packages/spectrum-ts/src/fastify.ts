// Re-export of the runtime's Fastify webhook handler so the
// `spectrum-ts/fastify` import path works through the metapackage.
export type {
  Message,
  Space,
  SpectrumPluginOptions,
  WebhookHandler,
} from "@spectrum-ts/core/fastify";
// biome-ignore lint/performance/noBarrelFile: clean entrypoint for the fastify adapter
export { spectrum } from "@spectrum-ts/core/fastify";
