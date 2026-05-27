import z from "zod";
import type { ContentBuilder } from "./types";

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

const isParsableUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Visible layout of a mini-app card. Mirrors Apple's
 * `MSMessageTemplateLayout`. At least one of `caption`, `subcaption`,
 * `trailingCaption`, `trailingSubcaption`, or `image` must be set so the
 * bubble is not empty. `image` and `imageTitle` must be set together;
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
  appStoreId: z.number().int().positive(),
  extensionBundleId: z.string().nonempty(),
  layout: layoutSchema,
  teamId: z.string().regex(TEAM_ID_PATTERN),
  url: z
    .string()
    .nonempty()
    .refine(isParsableUrl, { message: "url must be a parsable URL" }),
});

export type CustomizedMiniApp = z.infer<typeof customizedMiniAppSchema>;
export type CustomizedMiniAppLayout = z.infer<typeof layoutSchema>;

export interface CustomizedMiniAppInput {
  /** Display name of the owning app, shown by Messages fallback UI. */
  readonly appName: string;
  /** Apple App Store numeric id of the owning app. Must be a positive integer. */
  readonly appStoreId: number;
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
 * The layout is what recipients see in the bubble. `teamId`,
 * `extensionBundleId`, and `appStoreId` identify the iMessage extension that
 * receives `url` when the recipient taps the card; the server constructs the
 * matching `MSMessageExtensionBalloonPlugin` plugin id from these values.
 */
export function customizedMiniApp(
  input: CustomizedMiniAppInput
): ContentBuilder {
  return {
    build: async () => asCustomizedMiniApp(input),
  };
}
