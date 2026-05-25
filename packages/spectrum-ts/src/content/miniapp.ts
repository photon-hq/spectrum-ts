import z from "zod";
import type { ContentBuilder } from "./types";

export const miniAppSchema = z.object({
  type: z.literal("miniapp"),
  body: z.string().nonempty().optional(),
  caption: z.string().nonempty().optional(),
  detail: z.string().nonempty().optional(),
  footer: z.string().nonempty().optional(),
  imageJpeg: z.instanceof(Uint8Array).optional(),
  subtitle: z.string().nonempty().optional(),
  summary: z.string().nonempty().optional(),
  title: z.string().nonempty(),
  url: z.url(),
});

export type MiniApp = z.infer<typeof miniAppSchema>;

export interface MiniAppInput {
  /** Optional supporting text shown on the card. */
  readonly body?: string;
  /** Optional small label shown on the card. */
  readonly caption?: string;
  /** Optional detail label shown on the card. */
  readonly detail?: string;
  /** Optional secondary label shown on the card. */
  readonly footer?: string;
  /** Optional JPEG preview image bytes. */
  readonly imageJpeg?: Uint8Array;
  /** Optional secondary text shown on the card. */
  readonly subtitle?: string;
  /** Optional fallback text for surfaces that cannot render the full card. */
  readonly summary?: string;
  /** Required title shown on the card. */
  readonly title: string;
  /** URL opened when the recipient taps the card. */
  readonly url: string;
}

export const asMiniApp = (input: MiniAppInput): MiniApp =>
  miniAppSchema.parse({
    type: "miniapp",
    body: input.body,
    caption: input.caption,
    detail: input.detail,
    footer: input.footer,
    imageJpeg: input.imageJpeg,
    subtitle: input.subtitle,
    summary: input.summary,
    title: input.title,
    url: input.url,
  });

/**
 * Construct a `miniApp` content value.
 *
 * Recipients open `url` when they tap the card. Set the text and image fields
 * to the preview you want shown. `imageJpeg`, when supplied, must contain JPEG
 * bytes.
 */
export function miniApp(input: MiniAppInput): ContentBuilder {
  return {
    build: async () => asMiniApp(input),
  };
}
