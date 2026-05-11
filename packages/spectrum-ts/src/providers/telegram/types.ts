import z from "zod";
import type { SchemaMessage } from "../../platform/types";
import type { User } from "./generated/types";
import type { TelegramCache } from "./runtime/cache";
import type { TelegramClient } from "./runtime/client";

// Capacity `0` disables a slot (e.g. `messages: 0` makes `getMessage`
// always return `undefined`). Album coalescing is gated separately by
// `coalesceAlbums`; defaults live in `runtime/cache.ts`.
export const cacheConfigSchema = z
  .object({
    messages: z.number().int().nonnegative().optional(),
    polls: z.number().int().nonnegative().optional(),
    pollVotes: z.number().int().nonnegative().optional(),
    albumConcurrent: z.number().int().nonnegative().optional(),
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

// All extras are optional — including `firstName` / `isBot` / `chatId`
// which are always populated for wire-originated messages — because
// `telegram.user({ userID })` resolves with no chat context and the Bot
// API has no "fetch user by id" endpoint.
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

/**
 * Telegram-specific per-message extras.
 *
 * - `mediaGroupId`: shared id for every member of an album. With
 *   `coalesceAlbums: false` (default) each member surfaces individually;
 *   with `true` the events stream emits a single `group` message that
 *   still carries this id.
 * - `caption`: Telegram media messages can carry a caption alongside the
 *   file. Surfaced verbatim; absent on plain text and captionless messages.
 */
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
  /** Captured at `createClient` time; sender fallback for outbound paths. */
  me: User;
}
