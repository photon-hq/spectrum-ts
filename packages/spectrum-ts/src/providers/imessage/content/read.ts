import z from "zod";
import type { Content, ContentBuilder } from "../../../content/types";
import type { Message } from "../../../types/message";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

/**
 * iMessage-only "mark as read" content. Lives entirely under the iMessage
 * provider — never enters the universal `Content` discriminated union. The
 * framework recognizes it via two generic content-level contracts:
 *
 * 1. `__platform: "iMessage"` — `findUnsupportedPlatformContent` reads this
 *    tag and warns-and-skips when a different platform receives it.
 * 2. `__fireAndForget: true` — `dispatchSend`'s fire-and-forget check treats
 *    this as a side-effecting send that returns no message id, the same way
 *    it treats `reaction` / `typing` / `edit` / `background`.
 *
 * iMessage's `send` handler narrows back to `Read` via the `isRead` type
 * guard before dispatching to `chats.markRead`.
 */
export const readSchema = z.object({
  type: z.literal("read"),
  __platform: z.literal("iMessage"),
  __fireAndForget: z.literal(true),
  target: z.custom<Message>(isMessage, {
    message: "read target must be a Message",
  }),
});

export type Read = z.infer<typeof readSchema>;

export const isRead = (v: unknown): v is Read =>
  readSchema.safeParse(v).success;

/**
 * Mark the chat containing `target` as read. iMessage-only, remote-only.
 *
 * Implemented via `chats.markRead(chatGuid)`, which marks **every unread
 * message in the chat** as read — there is no per-message read receipt in
 * the SDK. `target` is used only to identify the chat (and to give
 * `message.read()` something to pass), so passing any message from a chat
 * marks the whole chat as read.
 *
 * `space.send(read(message))` is the canonical form; `space.read(message)`
 * and `message.read()` are sugar attached via the iMessage platform's
 * `space.actions` / `message.actions` slots.
 *
 * `Read` is intentionally not a member of the universal `Content` union —
 * the `as unknown as Content` cast keeps the builder shape compatible with
 * the framework's `ContentBuilder.build(): Promise<Content>` signature. The
 * framework treats it as a fire-and-forget control signal at runtime.
 */
export function read(target: Message): ContentBuilder {
  return {
    build: async () =>
      readSchema.parse({
        type: "read",
        __platform: "iMessage",
        __fireAndForget: true,
        target,
      }) as unknown as Content,
  };
}
