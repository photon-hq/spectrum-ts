import z from "zod";
import type { ContentBuilder } from "./types";

/**
 * A URL the platform should render as a rich link preview.
 *
 * Outbound-only by design: inbound messages always surface as `text` content —
 * a URL received from a platform arrives as plain text, never as `richlink`, so
 * no metadata is fetched on the inbound path. On outbound, each platform asks
 * its native client to render the preview (remote iMessage: `enableLinkPreview`;
 * Telegram: auto-unfurls the bare URL), so the framework carries only the URL
 * and fetches nothing itself.
 */
export const richlinkSchema = z.object({
  type: z.literal("richlink"),
  url: z.url(),
});

export type Richlink = z.infer<typeof richlinkSchema>;

export const asRichlink = (input: { url: string }): Richlink =>
  richlinkSchema.parse({ type: "richlink", url: input.url });

export function richlink(url: string): ContentBuilder {
  return {
    build: async () => asRichlink({ url }),
  };
}
