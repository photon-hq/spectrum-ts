import z from "zod";
import type { Content, ContentBuilder } from "../../../content/types";

/**
 * iMessage-only "request location" content. Lives entirely under the iMessage
 * provider — never enters the universal `Content` discriminated union. The
 * framework recognizes it via two generic content-level contracts:
 *
 * 1. `__platform: "iMessage"` — `findUnsupportedPlatformContent` in
 *    `platform/build.ts` reads this tag and warns-and-skips when a different
 *    platform receives it.
 * 2. `__fireAndForget: true` — `dispatchSend`'s fire-and-forget check treats
 *    this as a side-effecting send that returns no message id, the same way it
 *    treats `reaction` / `typing` / `background`.
 *
 * The content carries no data: the target chat and recipient are resolved at
 * send time from the space (`space.id` is the DM chat guid, which embeds the
 * other participant's address). iMessage's `send` handler narrows back to
 * `RequestLocation` via the `isRequestLocation` type guard before dispatching
 * to `locations.request`.
 */
export const requestLocationSchema = z.object({
  type: z.literal("request-location"),
  __platform: z.literal("iMessage"),
  __fireAndForget: z.literal(true),
});

export type RequestLocation = z.infer<typeof requestLocationSchema>;

export const isRequestLocation = (v: unknown): v is RequestLocation =>
  requestLocationSchema.safeParse(v).success;

/**
 * Send a Find My "share your location" request card into the current chat.
 * iMessage-only, remote-only, fire-and-forget, and currently scoped to 1:1
 * chats — the recipient is the other participant, derived from the chat guid.
 *
 * `space.send(requestLocation())` is the canonical form; `space.requestLocation()`
 * is sugar attached via `PlatformDef.space.actions` (only typed on
 * `PlatformSpace<IMessageDef>`).
 *
 * `RequestLocation` is intentionally not a member of the universal `Content`
 * union — the `as unknown as Content` cast keeps the builder shape compatible
 * with the framework's `ContentBuilder.build(): Promise<Content>` signature.
 * The framework treats it as a fire-and-forget control signal at runtime.
 */
export function requestLocation(): ContentBuilder {
  return {
    build: async () =>
      requestLocationSchema.parse({
        type: "request-location",
        __platform: "iMessage",
        __fireAndForget: true,
      }) as unknown as Content,
  };
}
