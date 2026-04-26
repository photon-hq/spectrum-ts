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
  chatId: z.union([z.string().trim().min(1), z.number().int()]),
});

/**
 * Telegram-specific per-message metadata surfaced as `Message` extras.
 *
 * - `mediaGroupId`: Telegram tags every member of an album (the multi-media
 *   bundle a user can send as a single composition) with a shared
 *   `media_group_id`. Album members still arrive as separate updates — there
 *   is no "album" update kind in the Bot API — so the provider deliberately
 *   does not coalesce them (that would require a stateful debounce cache).
 *   Consumers that want album semantics can group inbound messages by this id
 *   themselves. Absent on standalone messages.
 *
 * - `caption`: Telegram media messages (photo/video/audio/document/voice) can
 *   carry a caption alongside the file. Spectrum's universal content types
 *   model the media itself, not the accompanying caption text, so we surface
 *   the caption verbatim as an extra. Caption-only messages (no media)
 *   continue to flow through as `text` content. Absent on plain text and
 *   other captionless messages.
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
  client: TelegramClient;
}
