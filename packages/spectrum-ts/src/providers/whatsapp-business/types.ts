import z from "zod";
import type { SchemaMessage } from "../../platform/types";

export const configSchema = z.object({
  accessToken: z.string().min(1),
  phoneNumberId: z.string().min(1),
  appSecret: z.string().optional(),
});

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
});

export type WhatsAppMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
>;
