import z from "zod";
import { asStreamText } from "./stream-text";
import type { ContentBuilder } from "./types";

/**
 * Styled text written in standard markdown (CommonMark plus GFM tables and
 * strikethrough). Outbound-only by design: inbound messages always surface as
 * `text` content — no provider maps platform formatting back to markdown.
 * Each platform renders the markdown to its native format (Telegram: HTML via
 * `parse_mode`); platforms without native support receive readable plain text
 * via the send pipeline's markdown fallback.
 */
export const markdownSchema = z.object({
  type: z.literal("markdown"),
  markdown: z.string().nonempty(),
});

export type Markdown = z.infer<typeof markdownSchema>;

export const asMarkdown = (markdown: string): Markdown =>
  markdownSchema.parse({ type: "markdown", markdown });

/**
 * Send styled text written in standard markdown.
 *
 * - `markdown("**hi**")` sends the markdown as one message.
 * - `markdown(streamText(source))` marks a text stream as markdown: it builds
 *   the inner `streamText` content with `format: "markdown"`, so platforms
 *   with native support stream it styled (Telegram renders drafts and the
 *   final message via `parse_mode`) and everywhere else the accumulated text
 *   falls back through the markdown chain instead of surfacing raw `**`.
 *
 * Only `streamText` builders can be wrapped — markdown describes text, and a
 * stream is the only other content whose payload is text.
 */
export function markdown(source: string | ContentBuilder): ContentBuilder {
  if (typeof source === "string") {
    return { build: async () => asMarkdown(source) };
  }
  return {
    build: async () => {
      const inner = await source.build();
      if (inner.type !== "streamText") {
        throw new Error(
          `markdown() can only wrap streamText content (got "${inner.type}") — pass a string to send static markdown`
        );
      }
      return asStreamText({ stream: inner.stream, format: "markdown" });
    },
  };
}
