import z from "zod";
import type { Message } from "../types/message";
import type { ContentBuilder } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

/**
 * An `unsend` retracts a previously-sent outbound message.
 *
 * `space.send(unsend(message))` is the canonical outbound API;
 * `message.unsend()` and `space.unsend(message)` are sugar that delegate
 * here. Unsends are fire-and-forget — providers handle them inside their
 * `send` action and the resolved value is `undefined` (no new message id is
 * produced; the existing message is retracted in place).
 *
 * Platform constraints surface from the provider at send time — e.g.
 * iMessage enforces Apple's ~2-minute unsend window for regular messages
 * (reaction removal is not time-limited), and a late or repeated unsend
 * rejects with the provider's error. `space.getMessage(id)` results are
 * wrapped as inbound, so a message cannot be unsent from a refetched id
 * after a restart — keep the Message returned by `send` (same limitation
 * as `edit`).
 */
export const unsendSchema = z.object({
  type: z.literal("unsend"),
  target: z.custom<Message>(isMessage, {
    message: "unsend target must be a Message",
  }),
});

export type Unsend = z.infer<typeof unsendSchema>;

export const asUnsend = (input: { target: Message }): Unsend =>
  unsendSchema.parse({ type: "unsend", ...input });

/**
 * Construct an `unsend` content value retracting `target`.
 *
 * Only outbound messages (those sent by the agent) can be unsent; calling
 * this with an inbound target throws at build time so the misuse surfaces
 * before the send pipeline runs.
 *
 * Accepts `Message | undefined` so `space.send` results chain without
 * narrowing (`send` resolves `undefined` when a platform skips unsupported
 * content); an undefined target throws at build time.
 */
export function unsend(target: Message | undefined): ContentBuilder {
  return {
    build: async () => {
      if (!target) {
        throw new Error(
          "unsend() target is undefined — the targeted message was never sent (space.send resolves undefined when a platform skips unsupported content)"
        );
      }
      if (target.direction !== "outbound") {
        throw new Error(
          `unsend() target must be an outbound message (got direction "${target.direction}", message id "${target.id}")`
        );
      }
      return asUnsend({ target });
    },
  };
}
