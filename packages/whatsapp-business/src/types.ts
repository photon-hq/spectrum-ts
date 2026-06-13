import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { SchemaMessage } from "@spectrum-ts/core";
import z from "zod";

const directConfig = z.object({
  accessToken: z.string().min(1),
  appSecret: z.string().optional(),
  phoneNumberId: z.string().min(1),
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
