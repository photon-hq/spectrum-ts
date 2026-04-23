import z from "zod";
import type { SchemaMessage } from "../../platform/types";
import type { TelegramClient } from "./runtime/client";

export const configSchema = z.object({
  token: z.string().min(1),
  apiBaseUrl: z.string().url().optional(),
  pollingTimeout: z.number().int().positive().max(50).optional(),
  dropPendingUpdates: z.boolean().optional(),
});

export type TelegramConfig = z.infer<typeof configSchema>;

export const userSchema = z.object({});

export const spaceSchema = z.object({
  id: z.string(),
  chatId: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  username: z.string().optional(),
});

export const spaceParamsSchema = z.object({
  chatId: z.union([z.string().min(1), z.number().int()]),
});

export type TelegramMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
>;

export interface TelegramRuntime {
  abort: AbortController;
  client: TelegramClient;
}
