import z from "zod";
import type { SchemaMessage } from "../../platform/types";
import type { User } from "./generated/types";
import type { TelegramCache } from "./runtime/cache";
import type { TelegramClient } from "./runtime/client";

export const cacheConfigSchema = z
  .object({
    messages: z.number().int().positive().optional(),
    polls: z.number().int().positive().optional(),
    pollVotes: z.number().int().positive().optional(),
    albumConcurrent: z.number().int().positive().optional(),
    albumDebounceMs: z.number().int().nonnegative().optional(),
    albumCeilingMs: z.number().int().nonnegative().optional(),
    coalesceAlbums: z.boolean().optional(),
  })
  .optional();

export const configSchema = z.object({
  token: z.string().trim().min(1),
  apiBaseUrl: z.string().trim().url().optional(),
  pollingTimeout: z.number().int().positive().max(50).optional(),
  dropPendingUpdates: z.boolean().optional(),
  cache: cacheConfigSchema,
});

export type TelegramConfig = z.infer<typeof configSchema>;

// All fields optional: `telegram.user({ userID })` resolves with no chat
// context and the Bot API has no "fetch user by id" endpoint.
export const userSchema = z.object({
  chatId: z.number().int().optional(),
  firstName: z.string().optional(),
  isBot: z.boolean().optional(),
  lastName: z.string().optional(),
  username: z.string().optional(),
  languageCode: z.string().optional(),
});

export const spaceSchema = z.object({
  id: z.string(),
  chatId: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  username: z.string().optional(),
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

export interface TelegramRuntime {
  abort: AbortController;
  cache: TelegramCache;
  client: TelegramClient;
  me: User;
}
