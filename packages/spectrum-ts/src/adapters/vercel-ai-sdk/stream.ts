/**
 * Narrows responder output to a streamable async string source.
 *
 * This intentionally checks only the AsyncIterator protocol so callers can
 * return any async generator or compatible iterable without depending on a
 * Spectrum-specific type.
 */
export function isAsyncIterable(
  value: unknown
): value is AsyncIterable<string> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * Loads AI SDK stream helpers only when the adapter is executed.
 *
 * The package keeps `ai` as an optional peer so non-web Spectrum users are not
 * forced to install it. Calling this adapter without `ai` installed should fail
 * with a targeted setup error.
 */
export async function loadAiRuntime(): Promise<typeof import("ai")> {
  try {
    return await import("ai");
  } catch (cause) {
    throw new Error(
      'createSpectrumChatHandler requires the optional peer dependency "ai". Install it before using the Vercel AI SDK adapter.',
      { cause }
    );
  }
}

/**
 * Writes a string or async string stream as AI SDK UI text chunks.
 *
 * AI SDK UI requires a stable text part id across `text-start`,
 * `text-delta`, and `text-end`. This helper owns that wire protocol detail and
 * also stops consuming async iterable output once the request is aborted.
 */
export async function writeResponseText(options: {
  id: string;
  result: AsyncIterable<string> | string;
  signal: AbortSignal;
  writer: { write(part: unknown): void };
}): Promise<void> {
  const { id, result, signal, writer } = options;
  if (signal.aborted) {
    return;
  }

  writer.write({ type: "text-start", id });

  if (typeof result === "string") {
    if (!signal.aborted && result.length > 0) {
      writer.write({ type: "text-delta", id, delta: result });
    }
  } else {
    for await (const delta of result) {
      if (signal.aborted) {
        return;
      }
      if (delta.length > 0) {
        writer.write({ type: "text-delta", id, delta });
      }
    }
  }

  if (!signal.aborted) {
    writer.write({ type: "text-end", id });
  }
}
