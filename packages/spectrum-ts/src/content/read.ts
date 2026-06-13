import z from "zod";
import type { Message } from "../types/message";
import type { ContentBuilder } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

/**
 * A `read` marks the conversation as read **up to** `target`, surfacing a
 * read receipt to the sender where the platform supports one.
 *
 * `space.send(read(message))` is the canonical outbound API;
 * `message.read()` and `space.read(message)` are sugar that delegate here.
 * Reads are fire-and-forget — providers handle them inside their `send`
 * action and the resolved value is `undefined`.
 *
 * Granularity is per-platform:
 *
 * - WhatsApp Business: per-message receipt via `markRead(target.id)`, which
 *   also marks every earlier message in the conversation as read.
 * - iMessage (remote): chat-level `chats.markRead(chatGuid)` — `target` only
 *   identifies the chat, and **every** unread message in it is marked read.
 *   Local mode rejects with `UnsupportedError` (warned and skipped).
 * - Telegram / Slack: silently no-op. Neither surfaces read state for bot
 *   conversations (Telegram bot chats are effectively auto-read), so the
 *   signal is vacuously satisfied — same best-effort contract as `typing`.
 */
export const readSchema = z.object({
  type: z.literal("read"),
  target: z.custom<Message>(isMessage, {
    message: "read target must be a Message",
  }),
});

export type Read = z.infer<typeof readSchema>;

export const asRead = (input: { target: Message }): Read =>
  readSchema.parse({ type: "read", ...input });

/**
 * Construct a `read` content value marking the conversation read up to
 * `target`.
 *
 * Only inbound messages (those received from a user) can be marked read;
 * calling this with an outbound target throws at build time so the misuse
 * surfaces before the send pipeline runs. The target is required (not
 * `Message | undefined` like `unsend`): read targets come from the inbound
 * stream, never from a chainable `send()` result.
 */
export function read(target: Message): ContentBuilder {
  return {
    build: async () => {
      if (target.direction !== "inbound") {
        throw new Error(
          `read() target must be an inbound message (got direction "${target.direction}", message id "${target.id}")`
        );
      }
      return asRead({ target });
    },
  };
}
