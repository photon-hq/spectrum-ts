// Re-export of the runtime's Express webhook router so the
// `spectrum-ts/express` import path works through the metapackage.
export type {
  Message,
  Space,
  SpectrumPluginOptions,
  WebhookHandler,
} from "@spectrum-ts/core/express";
export { spectrum } from "@spectrum-ts/core/express";
