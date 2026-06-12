import type {
  Message,
  MessageReactionUpdated,
  Update,
} from "@photon-ai/telegram-ts";

// ---------------------------------------------------------------------------
// Inbound — Telegram webhook payloads, typed from `@photon-ai/telegram-ts` so
// the adapter stays in sync with the Bot API schema. These are types-only
// imports and disappear at build time.
// ---------------------------------------------------------------------------

export type {
  Message,
  MessageReactionUpdated,
  PhotoSize,
  ReactionType,
  ReactionTypeEmoji,
  Update,
  User,
} from "@photon-ai/telegram-ts";

/**
 * The payload `verify()` produces and `messages()` consumes: just the parsed
 * `Update`. Receiving is pure parsing — no client or config is bundled here.
 * The inbound mapper reads `config` from its own ctx (the Fusor `messages`
 * handler receives `{ config, payload, store, ... }`) and creates a client
 * inline only when it needs to download media bytes.
 */
export type TelegramPayload = Update;

/** An inbound `message_reaction` update. */
export type ReactionUpdate = MessageReactionUpdated;

// ---------------------------------------------------------------------------
// Outbound — the adapter's own DTOs at the Bot API boundary. Telegram has no
// multi-part message: each content type is a distinct Bot API method, so
// `buildSend` returns a *send spec* (one method call) rather than a parts list.
// `executeSpec` runs it through the photon client.
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
