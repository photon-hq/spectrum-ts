import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

// Direct-mode credentials fall back to `SPECTRUM_WHATSAPP_BUSINESS_*` env vars
// (explicit config wins), applied automatically by `definePlatform` from the
// platform id. A complete env set — access token + phone number id — satisfies
// `directConfig` even when `whatsappBusiness.config()` is called empty, so the
// union resolves to direct mode; a partial set fails `directConfig` and falls
// through to `cloudConfig`.
const directConfig = z.object({
  accessToken: z.string().min(1),
  appSecret: z.string().optional(),
  phoneNumberId: z.string().min(1),
});

const cloudConfig = z.object({}).strict();

export const configSchema = z.union([directConfig, cloudConfig]);

export type WhatsAppConfig = z.infer<typeof configSchema>;

// The vendor client doesn't retain the `phoneNumberId` it was created with, so
// carry the line alongside the client. Every creation site knows the line, and
// the required field makes "client without a line" a compile error.
export interface LineClient {
  client: WhatsAppClient;
  line: string;
}
export type WhatsAppClients = LineClient[];

export const isCloudConfig = (
  config: WhatsAppConfig
): config is z.infer<typeof cloudConfig> => !("accessToken" in config);

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
  line: z.string().optional(),
});

export type WhatsAppSpace = z.infer<typeof spaceSchema>;

export type WhatsAppMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
>;
