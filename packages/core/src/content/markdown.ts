import z from "zod";
import {
  type StreamTextSource,
  streamTextBuilder,
  type TextStreamOptions,
} from "./stream-text";
import type { ContentBuilder } from "./types";

/**
 * Styled text written in standard markdown (CommonMark plus GFM tables and
 * strikethrough). Outbound-only by design: inbound messages always surface as
 * `text` content — no provider maps platform formatting back to markdown.
 * Each platform renders the markdown to its native format (Telegram: HTML via
 * `parse_mode`; remote iMessage: styled text via UTF-16 formatting ranges);
 * platforms without native support receive readable plain text via the send
 * pipeline's markdown fallback.
 */
export const markdownSchema = z.object({
  type: z.literal("markdown"),
  markdown: z.string().nonempty(),
});

export type Markdown = z.infer<typeof markdownSchema>;

export const asMarkdown = (markdown: string): Markdown =>
  markdownSchema.parse({ type: "markdown", markdown });

/**
 * Send styled text written in standard markdown — a static string or a
 * streaming LLM response.
 *
 * - `markdown("**hi**")` sends the markdown as one message.
 * - `markdown(source)` marks a text stream as markdown: platforms with native
 *   support stream it styled (Telegram renders drafts and the final message
 *   via `parse_mode`), and everywhere else the accumulated text falls back
 *   through the markdown chain instead of surfacing raw `**` markers.
 *
 * Stream sources and options work exactly as in `text()` — any SDK streaming
 * result or `AsyncIterable` / `ReadableStream`, with `options.extract` for
 * unrecognized chunk shapes.
 */
export function markdown(source: string): ContentBuilder;
export function markdown<T = unknown>(
  source: StreamTextSource<T>,
  options?: TextStreamOptions<T>
): ContentBuilder;
export function markdown<T = unknown>(
  source: string | StreamTextSource<T>,
  options?: TextStreamOptions<T>
): ContentBuilder {
  if (typeof source === "string") {
    return { build: async () => asMarkdown(source) };
  }
  return streamTextBuilder("markdown", source, options);
}
