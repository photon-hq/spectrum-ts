import z from "zod";
import type { Message } from "../types/message";
import type { ContentBuilder } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

/**
 * A `typing` content value carries a typing-indicator signal — either
 * `"start"` or `"stop"`. Like `edit`, it's fire-and-forget: providers
 * dispatch on `content.type === "typing"` inside their `send()` action and
 * `space.send(typing(...))` resolves to `undefined`.
 *
 * `space.startTyping()` / `space.stopTyping()` / `space.responding()` are
 * sugar over `space.send(typing("start" | "stop"))`. Platforms that have no
 * typing-indicator API (e.g. Slack) silently no-op so the signal is
 * best-effort everywhere.
 *
 * `target` is the inbound message being responded to. Platforms whose typing
 * API must name one (WhatsApp Business) anchor on it and no-op without it.
 * The sugar fills it in on spaces that arrived with an inbound message.
 */
export const typingSchema = z.object({
  type: z.literal("typing"),
  state: z.enum(["start", "stop"]),
  target: z
    .custom<Message>(isMessage, {
      message: "typing target must be a Message",
    })
    .optional(),
});

export type Typing = z.infer<typeof typingSchema>;

export const isTyping = (value: unknown): value is Typing =>
  typingSchema.safeParse(value).success;

/**
 * Construct a `typing` content value. Defaults to `"start"`.
 *
 * `space.send(typing())` is equivalent to `space.startTyping()`;
 * `space.send(typing("stop"))` is equivalent to `space.stopTyping()`.
 * Pass `target` (the inbound message being responded to) for platforms that
 * anchor typing on a message; an outbound target throws at build time, like
 * `read()`.
 */
export function typing(
  state: "start" | "stop" = "start",
  target?: Message
): ContentBuilder {
  return {
    build: async () => {
      if (target && target.direction !== "inbound") {
        throw new Error(
          `typing() target must be an inbound message (got direction "${target.direction}", message id "${target.id}")`
        );
      }
      return typingSchema.parse({ type: "typing", state, target });
    },
  };
}
