import z from "zod";
import type { Message } from "../types/message";
import type { ContentBuilder } from "./types";

export const reactionSchema = z.object({
  type: z.literal("reaction"),
  emoji: z.string().min(1),
  target: z.string().min(1),
});

export type Reaction = z.infer<typeof reactionSchema>;

export const asReaction = (input: {
  emoji: string;
  target: string;
}): Reaction => reactionSchema.parse({ type: "reaction", ...input });

/**
 * Construct a `reaction` content value. Passing a `Message` extracts its id;
 * a string is treated as the target message id directly.
 *
 * `space.send(reaction(emoji, message))` is sugar for `message.react(emoji)`.
 * Reactions are fire-and-forget — the returned `OutboundMessage` will be
 * `undefined` because platforms do not surface a message id for reactions.
 */
export function reaction(
  emoji: string,
  target: Message | string
): ContentBuilder {
  const targetId = typeof target === "string" ? target : target.id;
  return { build: async () => asReaction({ emoji, target: targetId }) };
}
