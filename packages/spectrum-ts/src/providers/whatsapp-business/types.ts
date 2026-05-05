import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import z from "zod";
import type { SchemaMessage } from "../../platform/types";

const webhookIngressSchema = z.object({
  mode: z.literal("webhook"),
  verifyToken: z.string().min(1),
});

export type WebhookIngressConfig = z.infer<typeof webhookIngressSchema>;

const directConfig = z.object({
  accessToken: z.string().min(1),
  appSecret: z.string().optional(),
  phoneNumberId: z.string().min(1),
  ingress: webhookIngressSchema.optional(),
});

const cloudConfig = z.object({}).strict();

export const configSchema = z.union([directConfig, cloudConfig]);

export type WhatsAppConfig = z.infer<typeof configSchema>;
export type WhatsAppClients = WhatsAppClient[];

export const isCloudConfig = (
  config: WhatsAppConfig
): config is z.infer<typeof cloudConfig> => !("accessToken" in config);

export const isWebhookIngress = (
  config: WhatsAppConfig
): config is z.infer<typeof directConfig> & {
  ingress: WebhookIngressConfig;
} => "ingress" in config && config.ingress?.mode === "webhook";

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
});

export type WhatsAppMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
>;
