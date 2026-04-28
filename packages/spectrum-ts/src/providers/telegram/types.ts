import z from "zod";
import type { SchemaMessage } from "../../platform/types";
import type { User } from "./generated/types";
import type { TelegramCache } from "./runtime/cache";
import type { TelegramClient } from "./runtime/client";

// Cache capacity knobs. `0` disables a slot (e.g. `messages: 0` makes
// `getMessage` always return `undefined` and turns reaction-target hydration
// off). Album coalescing is gated by its own `coalesceAlbums` flag — when
// false, album members continue to surface as individual messages with a
// `mediaGroupId` extra (the pre-cache behaviour). See `runtime/cache.ts` for
// the rationale behind defaults.
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
  // Trim before length-check so a whitespace-only secret fails validation
  // up front rather than producing a 401 from Telegram on first request.
  token: z.string().trim().min(1),
  apiBaseUrl: z.string().trim().url().optional(),
  pollingTimeout: z.number().int().positive().max(50).optional(),
  dropPendingUpdates: z.boolean().optional(),
  cache: cacheConfigSchema,
});

export type TelegramConfig = z.infer<typeof configSchema>;

// Telegram users carry richer metadata than Spectrum's `User.id` — the bot
// API surfaces a numeric `id`, a bot/human flag, and free-form names. We
// declare those as schema-level extras so they're TS-visible on the
// resolved `User` (and therefore on `TelegramMessage["sender"]`) without
// requiring a cast at every construction site.
//
// All extras are *optional*, including `chatId` / `firstName` / `isBot`
// that are always populated for inbound messages and outbound sends. The
// reason is the third population path: `telegram.user({ userID })`, where
// Spectrum hands the resolver only the user id and there is no Bot API
// endpoint that fetches an arbitrary user by id without chat context.
// Marking these required would let TS callers assume `sender.firstName`
// is always a string when in resolver-only paths it's not — better to
// admit the truth and force callers to `?? "unknown"` or guard.
//
// Inbound mappers in `events/inbound.ts` and outbound builders in
// `messages.ts` populate every field they have, so the rich shape *is*
// available everywhere a Telegram message originated from the wire.
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
  cache: TelegramCache;
  client: TelegramClient;
  // Bot identity captured at `createClient` time via `getMe`. Used to
  // synthesize a sender on outbound records that don't carry one in the
  // API response (notably reactions, where Telegram returns a boolean).
  me: User;
}
