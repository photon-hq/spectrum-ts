import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { SchemaMessage } from "@spectrum-ts/core";
import { envFor, fromEnv } from "@spectrum-ts/core/authoring";
import z from "zod";

/**
 * Scoped env-var fallback for a WhatsApp Business config field. Each field falls
 * back to `SPECTRUM_WHATSAPP_BUSINESS_<KEY>` when omitted (explicit config wins).
 */
const env = <T extends z.ZodType>(key: string, schema: T) =>
  fromEnv(envFor("WHATSAPP_BUSINESS", key), schema);

// Direct-mode credentials fall back to `SPECTRUM_WHATSAPP_BUSINESS_*` env vars
// (explicit config wins). A complete env set — access token + phone number id —
// satisfies `directConfig` even when `whatsappBusiness.config()` is called
// empty, so the union resolves to direct mode; a partial set fails `directConfig`
// and falls through to `cloudConfig`.
const directConfig = z.object({
  accessToken: env("ACCESS_TOKEN", z.string().min(1)),
  appSecret: env("APP_SECRET", z.string().optional()),
  phoneNumberId: env("PHONE_NUMBER_ID", z.string().min(1)),
});

const cloudConfig = z.object({}).strict();

export const configSchema = z.union([directConfig, cloudConfig]);

export type WhatsAppConfig = z.infer<typeof configSchema>;
export type WhatsAppClients = WhatsAppClient[];

export const isCloudConfig = (
  config: WhatsAppConfig
): config is z.infer<typeof cloudConfig> => !("accessToken" in config);

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
});

export type WhatsAppMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
>;
