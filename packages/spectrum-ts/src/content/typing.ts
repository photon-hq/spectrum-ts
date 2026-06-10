import z from "zod";
import type { ContentBuilder } from "./types";

/**
 * A `typing` content value carries a typing-indicator signal — either
 * `"start"` or `"stop"`. Like `edit`, it's fire-and-forget: providers
 * dispatch on `content.type === "typing"` inside their `send()` action and
 * `space.send(typing(...))` resolves to `undefined`.
 *
 * `space.startTyping()` / `space.stopTyping()` / `space.responding()` are
 * sugar over `space.send(typing("start" | "stop"))`. Platforms that have no
 * typing-indicator API (e.g. WhatsApp Business) silently no-op so the
 * signal is best-effort everywhere.
 */
export const typingSchema = z.object({
  type: z.literal("typing"),
  state: z.enum(["start", "stop"]),
});

export type Typing = z.infer<typeof typingSchema>;

export const isTyping = (value: unknown): value is Typing =>
  typingSchema.safeParse(value).success;

/**
 * Construct a `typing` content value. Defaults to `"start"`.
 *
 * `space.send(typing())` is equivalent to `space.startTyping()`;
 * `space.send(typing("stop"))` is equivalent to `space.stopTyping()`.
 */
export function typing(state: "start" | "stop" = "start"): ContentBuilder {
  return {
    build: async () => typingSchema.parse({ type: "typing", state }),
  };
}
