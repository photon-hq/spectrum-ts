import z from "zod";
import type { ContentBuilder } from "./types";

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

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

export const customizedMiniAppSchema = z.object({
  type: z.literal("customized-mini-app"),
  appName: z.string().nonempty(),
  appStoreId: z.number().int().positive().optional(),
  extensionBundleId: z.string().nonempty(),
  layout: layoutSchema,
  teamId: z.string().regex(TEAM_ID_PATTERN),
  url: z.url(),
});

export type CustomizedMiniApp = z.infer<typeof customizedMiniAppSchema>;
export type CustomizedMiniAppLayout = z.infer<typeof layoutSchema>;

export interface CustomizedMiniAppInput {
  /** Display name of the owning app, shown by Messages fallback UI. */
  readonly appName: string;
  /**
   * Apple App Store numeric id of the owning app. Must be a positive integer
   * when set. Omit to send a card whose extension is not published on the App
   * Store — recipients without the extension installed then see no store entry.
   */
  readonly appStoreId?: number;
  /** Bundle identifier of the iMessage extension target. */
  readonly extensionBundleId: string;
  /** Visible card layout. */
  readonly layout: CustomizedMiniAppLayout;
  /** 10-character uppercase alphanumeric Apple Team ID. */
  readonly teamId: string;
  /** Absolute URL delivered to the installed extension on tap. */
  readonly url: string;
}

export const asCustomizedMiniApp = (
  input: CustomizedMiniAppInput
): CustomizedMiniApp =>
  customizedMiniAppSchema.parse({
    type: "customized-mini-app",
    ...input,
  });

/**
 * Construct a `customized-mini-app` content value.
 *
 * The layout is what recipients see in the bubble. `teamId` and
 * `extensionBundleId` identify the iMessage extension that receives `url` when
 * the recipient taps the card; the server constructs the matching
 * `MSMessageExtensionBalloonPlugin` plugin id from these values. `appStoreId`
 * is optional and only points recipients without the extension at its App
 * Store entry.
 */
export function customizedMiniApp(
  input: CustomizedMiniAppInput
): ContentBuilder {
  return {
    build: async () => asCustomizedMiniApp(input),
  };
}
