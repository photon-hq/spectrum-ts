import z from "zod";
import type { Message } from "../types/message";
import type { ContentBuilder } from "./types";

/**
 * A `ContentBuilder` whose build is statically known to produce `Reaction`
 * content. `space.send` overloads on this so `space.send(reaction(...))`
 * returns a Message with `content` narrowed to `Reaction`, matching
 * `message.react()`.
 */
export interface ReactionBuilder extends ContentBuilder {
  build(): Promise<Reaction>;
}

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
 * `space.send(reaction(emoji, message))` is the canonical form of
 * `message.react(emoji)`. It resolves to the reaction `Message`
 * (`content.type === "reaction"`) — keep it as the handle to `unsend()`
 * later. Resolves `undefined` only when the platform does not support
 * reactions (warned and skipped).
 *
 * Accepts `Message | undefined` so `space.send` results chain without
 * narrowing (`send` resolves `undefined` when a platform skips unsupported
 * content); an undefined target throws at build time.
 *
 * To react to a message known only by id, resolve it first via
 * `space.getMessage(id)`.
 */
export function reaction(
  emoji: string,
  target: Message | undefined
): ReactionBuilder {
  return {
    build: async () => {
      if (!target) {
        throw new Error(
          "reaction() target is undefined — the targeted message was never sent (space.send resolves undefined when a platform skips unsupported content)"
        );
      }
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
