import type { Message, MessageReactionUpdated, Update } from "@grammyjs/types";
import type { TelegramClient } from "./client";

// ---------------------------------------------------------------------------
// Inbound — Telegram webhook payloads, typed from the official `@grammyjs/types`
// package so the adapter stays in sync with the Bot API schema. These are
// types-only imports and disappear at build time.
// ---------------------------------------------------------------------------

export type {
  Message,
  MessageReactionUpdated,
  PhotoSize,
  ReactionType,
  ReactionTypeEmoji,
  Update,
  User,
} from "@grammyjs/types";

/**
 * The payload `verify()` produces and `messages()` consumes. The raw `Update`
 * plus the `TelegramClient` — the `messages` hook receives only `{ payload,
 * respond }` (no store/config), so the client is threaded through here to build
 * the lazy media `read()` closures (inbound media is fetched with the bot
 * token, unlike presigned-URL platforms). The client never lands in a
 * `ProviderMessageRecord`; only `() => client.download(fileId)` closures do.
 */
export interface TelegramPayload {
  client: TelegramClient;
  update: Update;
}

/** An inbound `message_reaction` update. */
export type ReactionUpdate = MessageReactionUpdated;

// ---------------------------------------------------------------------------
// Outbound — the adapter's own DTOs at the `TelegramClient` boundary. Telegram
// has no multi-part message: each content type is a distinct Bot API method, so
// `buildSend` returns a *send spec* (one method call) rather than a parts list.
// ---------------------------------------------------------------------------

/** A file to upload as `multipart/form-data` under `field` (e.g. `photo`). */
export interface TelegramSendFile {
  bytes: Buffer;
  field: string;
  filename: string;
  mimeType: string;
}

/** One Bot API call: a method, its JSON params, and an optional uploaded file. */
export interface TelegramSendSpec {
  file?: TelegramSendFile;
  method: string;
  params: Record<string, unknown>;
}

/** The subset of a sent `Message` the adapter reads back after a successful send. */
export type SentMessage = Pick<Message, "message_id" | "date">;
