import type { Content, ContentBuilder } from "@spectrum-ts/core";
import z from "zod";

/**
 * Visible layout of a mini-app card. Mirrors Apple's
 * `MSMessageTemplateLayout`. At least one of `caption`, `subcaption`,
 * `trailingCaption`, `trailingSubcaption`, or `image` must be set so the
 * bubble is not empty — `summary` is the fallback text shown on surfaces
 * that cannot render the card (notifications, lock screen) and is not a
 * visible slot on its own. `image` and `imageTitle` must be set together;
 * `imageSubtitle` requires `image`.
 */
const layoutSchema = z
  .object({
    caption: z.string().nonempty().optional(),
    subcaption: z.string().nonempty().optional(),
    trailingCaption: z.string().nonempty().optional(),
    trailingSubcaption: z.string().nonempty().optional(),
    image: z.instanceof(Uint8Array).optional(),
    imageTitle: z.string().nonempty().optional(),
    imageSubtitle: z.string().nonempty().optional(),
    summary: z.string().nonempty().optional(),
  })
  .refine(
    (layout) =>
      layout.caption !== undefined ||
      layout.subcaption !== undefined ||
      layout.trailingCaption !== undefined ||
      layout.trailingSubcaption !== undefined ||
      layout.image !== undefined,
    {
      message:
        "layout must set at least one of caption, subcaption, trailingCaption, trailingSubcaption, image",
    }
  )
  .refine(
    (layout) =>
      (layout.image === undefined) === (layout.imageTitle === undefined),
    {
      message: "layout.image and layout.imageTitle must be set together",
      path: ["imageTitle"],
    }
  )
  .refine(
    (layout) =>
      layout.imageSubtitle === undefined || layout.image !== undefined,
    {
      message: "layout.imageSubtitle requires layout.image",
      path: ["imageSubtitle"],
    }
  );

/**
 * iMessage-only mini-app card content. Lives entirely under the iMessage
 * provider — never enters the universal `Content` discriminated union. The
 * framework recognizes it via the generic content-level platform contract:
 *
 * - `__platform: "iMessage"` — `findUnsupportedPlatformContent` reads this tag
 *   and warns-and-skips when a different platform receives it.
 *
 * Unlike `background` / `read`, this content is **not** `__fireAndForget`: it
 * produces a real outbound message, so the iMessage `send` handler narrows
 * back to `CustomizedMiniApp` via the `isCustomizedMiniApp` guard and returns
 * the resulting `ProviderMessageRecord` (rather than `void`).
 */
export const customizedMiniAppSchema = z.object({
  type: z.literal("customized-mini-app"),
  __platform: z.literal("iMessage"),
  // Display name of the owning app, shown by Messages fallback UI.
  appName: z.string().nonempty(),
  // Apple App Store numeric id of the owning app. Positive when set; omit to
  // send a card whose extension is not published on the App Store.
  appStoreId: z.number().int().positive().optional(),
  // Bundle identifier of the iMessage extension target.
  extensionBundleId: z.string().nonempty(),
  // Visible card layout.
  layout: layoutSchema,
  // 10-character uppercase alphanumeric Apple Team ID.
  teamId: z.string(),
  // Absolute URL delivered to the installed extension on tap.
  url: z.url(),
});

export type CustomizedMiniApp = z.infer<typeof customizedMiniAppSchema>;
export type CustomizedMiniAppLayout = z.infer<typeof layoutSchema>;

export type CustomizedMiniAppInput = Omit<
  CustomizedMiniApp,
  "type" | "__platform"
>;

export const isCustomizedMiniApp = (v: unknown): v is CustomizedMiniApp =>
  customizedMiniAppSchema.safeParse(v).success;

export const asCustomizedMiniApp = (
  input: CustomizedMiniAppInput
): CustomizedMiniApp =>
  customizedMiniAppSchema.parse({
    type: "customized-mini-app",
    __platform: "iMessage",
    ...input,
  });

/**
 * Construct a `customized-mini-app` content value. iMessage-only, remote-only.
 *
 * The layout is what recipients see in the bubble. `teamId` and
 * `extensionBundleId` identify the iMessage extension that receives `url` when
 * the recipient taps the card; the server constructs the matching
 * `MSMessageExtensionBalloonPlugin` plugin id from these values. `appStoreId`
 * is optional and only points recipients without the extension at its App
 * Store entry.
 *
 * `space.send(customizedMiniApp(...))` is the canonical form.
 *
 * `CustomizedMiniApp` is intentionally not a member of the universal `Content`
 * union — the `as unknown as Content` cast keeps the builder shape compatible
 * with the framework's `ContentBuilder.build(): Promise<Content>` signature.
 */
export function customizedMiniApp(
  input: CustomizedMiniAppInput
): ContentBuilder {
  return {
    build: async () => asCustomizedMiniApp(input) as unknown as Content,
  };
}
