import type { Content, ContentBuilder } from "@spectrum-ts/core";
import z from "zod";

/**
 * iMessage-only "share contact card" control signal. Pushes the *local
 * account's native contact card* (the name + photo a recipient sees in their
 * Messages app) to a chat via the SDK's `chats.shareContactInfo`.
 *
 * This is Apple's "Share Name and Photo" mechanism — distinct from the
 * universal `contact(...)` content, which uploads an arbitrary person's vCard
 * as a *file* attachment. There is no payload: the card shared is always the
 * bot account's own.
 *
 * Like `background`, it lives entirely under the iMessage provider and never
 * enters the universal `Content` discriminated union. The framework recognizes
 * it via two generic content-level contracts:
 *
 * 1. `__platform: "imessage"` — `findUnsupportedPlatformContent` in
 *    `platform/build.ts` reads this tag and warns-and-skips when a different
 *    platform receives it.
 * 2. `__fireAndForget: true` — `dispatchSend`'s fire-and-forget check treats
 *    this as a side-effecting send that returns no message id, the same way it
 *    treats `read` / `typing`.
 *
 * iMessage's `send` handler narrows back via the `isContactCard` type guard
 * before dispatching to `chats.shareContactInfo`.
 */
export const contactCardSchema = z.object({
  type: z.literal("contactCard"),
  __platform: z.literal("imessage"),
  __fireAndForget: z.literal(true),
});

export type ContactCard = z.infer<typeof contactCardSchema>;

export const isContactCard = (v: unknown): v is ContactCard =>
  contactCardSchema.safeParse(v).success;

/**
 * Share the bot account's native iMessage contact card (name + photo) with the
 * chat. iMessage-only, remote-only.
 *
 * `space.send(nativeContactCard())` is the canonical form; `space.shareContactCard()`
 * is sugar attached via `PlatformDef.space.actions` (only typed on
 * `PlatformSpace<IMessageDef>`).
 *
 * This is an explicit, on-demand share and always fires — unlike the automatic
 * best-effort share gated behind the `imessageSynced` project profile, which
 * dedupes to once per chat per 24h (see `remote/contact-share.ts`). Works in
 * both DMs and group chats; the recipient chooses whether to accept the card.
 *
 * `ContactCard` is intentionally not a member of the universal `Content`
 * union — the `as unknown as Content` cast keeps the builder shape compatible
 * with the framework's `ContentBuilder.build(): Promise<Content>` signature.
 * The framework treats it as a fire-and-forget control signal at runtime.
 */
export function nativeContactCard(): ContentBuilder {
  return {
    build: async () =>
      contactCardSchema.parse({
        type: "contactCard",
        __platform: "imessage",
        __fireAndForget: true,
      }) as unknown as Content,
  };
}
