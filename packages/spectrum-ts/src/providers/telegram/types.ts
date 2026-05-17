import type { TelegramClient } from "@photon-ai/telegram";
import z from "zod";
import type { SchemaMessage } from "../../platform/types";

const directConfig = z.object({
  botToken: z.string().trim().min(1),
  endpoint: z.string().trim().min(1).optional(),
});

const cloudConfig = z.object({}).strict();

export const configSchema = z.union([directConfig, cloudConfig]);

export type TelegramConfig = z.infer<typeof configSchema>;
export type TelegramClients = TelegramClient[];

export const isCloudConfig = (
  config: TelegramConfig
): config is z.infer<typeof cloudConfig> => !("botToken" in config);

// Telegram has no Bot-API "fetch user" endpoint. We expose every field as
// optional so callers can supply whatever they have (or just a userID) and
// downstream content builders read them defensively.
export const userSchema = z.object({
  firstName: z.string().optional(),
  isBot: z.boolean().optional(),
  lastName: z.string().optional(),
  username: z.string().optional(),
  languageCode: z.string().optional(),
});

// v1 keeps the space minimal — `id` is the Telegram chat_id stringified.
// Chat metadata (type/title/username) is populated lazily off the next
// inbound message's `chat` payload; see PLAN-MIGRATION.md for the
// follow-up `ResolveChat` RPC.
export const spaceSchema = z.object({
  id: z.string(),
});

export const spaceParamsSchema = z.object({
  chatId: z.union([z.string().trim().min(1), z.number().int()]),
});

// `mediaGroupId`: shared id across all members of a Telegram album.
// `caption`: present on media messages that ship with caption text.
export const messageSchema = z.object({
  mediaGroupId: z.string().optional(),
  caption: z.string().optional(),
});

export type TelegramMessage = SchemaMessage<
  typeof userSchema,
  typeof spaceSchema
> & {
  mediaGroupId?: string;
  caption?: string;
};
