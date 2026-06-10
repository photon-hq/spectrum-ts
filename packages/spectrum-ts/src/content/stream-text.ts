import z from "zod";
import type { ContentBuilder } from "./types";

/**
 * Maps one chunk emitted by a stream to the incremental text it carries.
 * Return a string to emit, or `null`/`undefined` to skip the chunk (e.g. for
 * control events that carry no text).
 */
export type DeltaExtractor<T> = (chunk: T) => string | null | undefined;

/**
 * Anything `streamText()` accepts as a source. The builder normalizes all of
 * these to an internal `AsyncIterable<string>` of text deltas:
 *
 * - the Vercel AI SDK `streamText()` result (its `.textStream` is picked up
 *   automatically — pass either the whole result or `.textStream` directly),
 * - a raw `AsyncIterable<T>` (e.g. an OpenAI / Anthropic streaming response),
 * - a raw `ReadableStream<T>` of chunks.
 */
export type StreamTextSource<T = unknown> =
  | { textStream: AsyncIterable<string> | ReadableStream<string> }
  | AsyncIterable<T>
  | ReadableStream<T>;

export interface StreamTextOptions<T = unknown> {
  /**
   * Map each chunk to its incremental text. Omit to rely on built-in
   * auto-detection of the common SDK shapes (OpenAI chat/responses, Anthropic
   * messages, AI SDK text streams, and plain strings).
   */
  extract?: DeltaExtractor<T>;
}

export const streamTextSchema = z.object({
  type: z.literal("streamText"),
  // A single-consumption producer of normalized text deltas. The builder
  // closes over the normalized source; the platform driver calls it once.
  // Kept opaque to Zod via `z.custom` (same approach as `attachment.read`).
  stream: z.custom<() => AsyncIterable<string>>(
    (v) => typeof v === "function",
    {
      message:
        "streamText.stream must be a function returning AsyncIterable<string>",
    }
  ),
});

export type StreamText = z.infer<typeof streamTextSchema>;

// `string` = a text delta to emit, `null` = a recognized chunk that carries no
// text (skip it), `undefined` = an unrecognized shape (try the next extractor).
type ExtractResult = string | null | undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

// Anthropic / streaming control events that carry no text and should be skipped
// rather than treated as an error.
const SKIP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_stop",
  "ping",
]);

// OpenAI `responses` streaming. The stream interleaves the text delta event
// (`response.output_text.delta`) with many lifecycle events (`response.created`,
// `response.output_text.done`, …) — recognize the whole `response.*` family so
// the raw stream can be passed straight in, emitting only the text deltas.
const fromOpenAIResponses = (obj: Record<string, unknown>): ExtractResult => {
  const type = obj.type;
  if (typeof type !== "string" || !type.startsWith("response.")) {
    return;
  }
  if (type === "response.output_text.delta" && typeof obj.delta === "string") {
    return obj.delta;
  }
  return null; // other response.* lifecycle events carry no plain text
};

// Anthropic raw event: `{ type: "content_block_delta", delta: { type, text } }`.
const fromAnthropicDelta = (obj: Record<string, unknown>): ExtractResult => {
  if (obj.type !== "content_block_delta") {
    return;
  }
  const delta = asRecord(obj.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  // A non-text content_block_delta (e.g. an input_json_delta) — skip.
  return null;
};

// AI SDK `fullStream` text part: `{ type: "text-delta", textDelta | text }`.
const fromAiSdkPart = (obj: Record<string, unknown>): ExtractResult => {
  if (obj.type !== "text-delta") {
    return;
  }
  if (typeof obj.textDelta === "string") {
    return obj.textDelta;
  }
  return typeof obj.text === "string" ? obj.text : null;
};

// OpenAI `chat.completions` chunk: `choices[0].delta.content` (string | null).
const fromOpenAIChat = (obj: Record<string, unknown>): ExtractResult => {
  if (!Array.isArray(obj.choices)) {
    return;
  }
  const delta = asRecord(asRecord(obj.choices[0])?.delta);
  const content = delta?.content;
  // Recognized chat chunk — emit the text, or skip role-only / finish chunks.
  return typeof content === "string" ? content : null;
};

const fromControlEvent = (obj: Record<string, unknown>): ExtractResult =>
  typeof obj.type === "string" && SKIP_EVENT_TYPES.has(obj.type)
    ? null
    : undefined;

const OBJECT_EXTRACTORS: ReadonlyArray<
  (obj: Record<string, unknown>) => ExtractResult
> = [
  fromOpenAIResponses,
  fromAnthropicDelta,
  fromAiSdkPart,
  fromOpenAIChat,
  fromControlEvent,
];

/**
 * Auto-detect the text delta in a chunk from a popular LLM SDK. Pass a custom
 * `extract` to `streamText()` for any shape this doesn't recognize.
 */
const defaultExtract: DeltaExtractor<unknown> = (chunk) => {
  if (typeof chunk === "string") {
    return chunk;
  }
  const record = asRecord(chunk);
  if (!record) {
    throw new Error(
      `streamText: cannot extract a text delta from a ${typeof chunk} chunk. Pass { extract } to map your stream's chunks to text.`
    );
  }
  for (const extractor of OBJECT_EXTRACTORS) {
    const result = extractor(record);
    if (result !== undefined) {
      return result;
    }
  }
  throw new Error(
    `streamText: unrecognized chunk shape (type=${String(record.type)}). Pass an { extract } function to map your provider's chunk to a text delta.`
  );
};

const isReadableStream = (value: unknown): value is ReadableStream<unknown> =>
  typeof (value as ReadableStream<unknown>)?.getReader === "function";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof (value as AsyncIterable<unknown>)?.[Symbol.asyncIterator] ===
  "function";

async function* readableToAsync<T>(
  source: ReadableStream<T>
): AsyncIterable<T> {
  // Prefer native async iteration when the runtime supports it; otherwise fall
  // back to a manual reader loop, releasing the lock when done.
  if (isAsyncIterable(source)) {
    yield* source as AsyncIterable<T>;
    return;
  }
  // Older runtimes: the async-iterable guard above narrows `source` to `never`
  // here (its lib type is already async-iterable), so reassert the stream type.
  const reader = (source as ReadableStream<T>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

const resolveChunkIterable = <T>(
  source: StreamTextSource<T>
): AsyncIterable<unknown> => {
  const textStream = (source as { textStream?: unknown }).textStream;
  if (textStream != null) {
    if (isReadableStream(textStream)) {
      return readableToAsync(textStream);
    }
    if (isAsyncIterable(textStream)) {
      return textStream;
    }
    throw new Error(
      "streamText: `.textStream` must be an AsyncIterable or a ReadableStream."
    );
  }
  if (isReadableStream(source)) {
    return readableToAsync(source);
  }
  if (isAsyncIterable(source)) {
    return source;
  }
  throw new Error(
    "streamText: source must be an AsyncIterable, a ReadableStream, or an object with a `.textStream` (e.g. the AI SDK streamText() result)."
  );
};

/**
 * Thrown when a single-use stream source is consumed a second time. The send
 * pipeline's plain-text fallback matches on this to tell "the provider already
 * consumed the stream" apart from a stream that errored mid-drain.
 */
export class StreamConsumedError extends Error {
  constructor() {
    super(
      "streamText: this source has already been consumed — a stream can only be sent once."
    );
    this.name = "StreamConsumedError";
  }
}

const normalize = <T>(
  source: StreamTextSource<T>,
  options?: StreamTextOptions<T>
): (() => AsyncIterable<string>) => {
  const extract: DeltaExtractor<unknown> = options?.extract
    ? (options.extract as DeltaExtractor<unknown>)
    : defaultExtract;
  let consumed = false;
  return async function* normalized() {
    if (consumed) {
      throw new StreamConsumedError();
    }
    consumed = true;
    for await (const chunk of resolveChunkIterable(source)) {
      const delta = extract(chunk);
      if (delta) {
        yield delta;
      }
    }
  };
};

export const asStreamText = (input: {
  stream: () => AsyncIterable<string>;
}): StreamText =>
  streamTextSchema.parse({ type: "streamText", stream: input.stream });

/**
 * Consume a `streamText` content's stream to completion and return the full
 * accumulated text. Used by the send pipeline's plain-text fallback for
 * platforms that can't stream. Consumes the single-use stream — the content
 * cannot be sent afterwards.
 */
export const drainStreamText = async (content: StreamText): Promise<string> => {
  let full = "";
  for await (const delta of content.stream()) {
    full += delta;
  }
  return full;
};

/**
 * Wrap a streaming LLM text response so it can be sent like any other content.
 *
 * Delivery is platform-specific — iMessage (remote) sends the first chunk as a
 * real message and then edits it in place as more text arrives; Telegram
 * (private chats) animates a native draft preview and persists the final text
 * as one message. Platforms that can't stream wait for the stream to finish
 * and deliver the accumulated text as one plain message.
 *
 * Accepts whatever the popular SDKs return; pass `options.extract` for any
 * chunk shape the built-in detection doesn't recognize.
 */
export function streamText<T = unknown>(
  source: StreamTextSource<T>,
  options?: StreamTextOptions<T>
): ContentBuilder {
  return {
    build: async () => asStreamText({ stream: normalize(source, options) }),
  };
}
