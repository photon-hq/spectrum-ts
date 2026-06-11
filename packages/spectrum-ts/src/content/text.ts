import z from "zod";
import {
  type StreamTextSource,
  streamTextBuilder,
  type TextStreamOptions,
} from "./stream-text";
import type { ContentBuilder } from "./types";

export const textSchema = z.object({
  type: z.literal("text"),
  text: z.string().nonempty(),
});

export const asText = (text: string): z.infer<typeof textSchema> =>
  textSchema.parse({ type: "text", text });

/**
 * Send plain text — a static string or a streaming LLM response.
 *
 * `text("hi")` sends one message. `text(source)` wraps a text stream so it
 * can be sent like any other content; delivery is platform-specific —
 * iMessage (remote) sends the first chunk as a real message and then edits it
 * in place as more text arrives; Telegram (private chats) animates a native
 * draft preview and persists the final text as one message. Platforms that
 * can't stream wait for the stream to finish and deliver the accumulated text
 * as one plain message.
 *
 * A stream source accepts whatever the popular SDKs return (the AI SDK
 * `streamText()` result, OpenAI / Anthropic streaming responses, or any
 * `AsyncIterable` / `ReadableStream`); pass `options.extract` for any chunk
 * shape the built-in detection doesn't recognize. A stream can only be sent
 * once. Options apply to stream sources only — they are ignored for strings.
 *
 * For text written in markdown, use `markdown()` instead.
 */
export function text(source: string): ContentBuilder;
export function text<T = unknown>(
  source: StreamTextSource<T>,
  options?: TextStreamOptions<T>
): ContentBuilder;
export function text<T = unknown>(
  source: string | StreamTextSource<T>,
  options?: TextStreamOptions<T>
): ContentBuilder {
  if (typeof source === "string") {
    return { build: async () => asText(source) };
  }
  return streamTextBuilder("text", source, options);
}
