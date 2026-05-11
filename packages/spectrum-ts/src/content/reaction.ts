import z from "zod";
import type { Message } from "../types/message";
import type { ContentBuilder } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

export const reactionSchema = z.object({
  type: z.literal("reaction"),
  emoji: z.string().min(1),
  target: z.custom<Message>(isMessage, {
    message: "reaction target must be a Message",
  }),
});

export type Reaction = z.infer<typeof reactionSchema>;

export const asReaction = (input: {
  emoji: string;
  target: Message;
}): Reaction => reactionSchema.parse({ type: "reaction", ...input });

/**
 * Construct a `reaction` content value targeting the given message.
 *
 * `space.send(reaction(emoji, message))` is sugar for `message.react(emoji)`.
 * Reactions are fire-and-forget — the returned `OutboundMessage` will be
 * `undefined` because platforms do not surface a message id for reactions.
 *
 * To react to a message known only by id, resolve it first via
 * `space.getMessage(id)`.
 */
export function reaction(emoji: string, target: Message): ContentBuilder {
  return {
    build: async () => {
      // Reacting to a reaction is universally nonsensical — guard against it
      // mirroring `reply()`'s reject-list. Replies and group items are valid
      // reaction targets (real chat clients allow both), so only reject this.
      if (target.content.type === "reaction") {
        throw new Error('reaction() cannot target "reaction" content');
      }
      return asReaction({ emoji, target });
    },
  };
}
