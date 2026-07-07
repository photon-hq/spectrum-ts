import {
  appLayoutSchema,
  type Content,
  type ContentBuilder,
} from "@spectrum-ts/core";
import z from "zod";

// The mini-app card layout is the universal `AppLayout` (promoted to
// `@spectrum-ts/core` so the framework `app` content and this iMessage-only
// primitive share one source of truth). It mirrors Apple's
// `MSMessageTemplateLayout`.
const layoutSchema = appLayoutSchema;

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
  // Render with the installed extension's live UI when available.
  live: z.boolean().optional(),
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
 * Store entry. `live` is optional; when omitted, the remote server keeps the
 * static layout preview visible.
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
