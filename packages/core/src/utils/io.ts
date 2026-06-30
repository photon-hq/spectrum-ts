import { sanitizeUrl } from "@photon-ai/otel";
import z from "zod";
import { tracedFetch } from "./instrumented-fetch";

export const readSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(Buffer)),
});

export const streamSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(ReadableStream)),
});

export const bufferToStream = (buf: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });

export interface FetchedBytes {
  data: Buffer;
  mimeType?: string;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

// Spectrum's own media/URL downloads, traced as CLIENT spans. sanitizeUrl
// scrubs presigned-URL secrets from the recorded url.full (the real request
// still uses the original URL).
const mediaFetch = tracedFetch("media", { redactUrl: sanitizeUrl });

/**
 * Fetch URL bytes into memory — never touches the filesystem, so callers
 * remain safe in read-only environments. Returns the response's Content-Type
 * alongside the bytes so callers that want a soft MIME fallback can use it.
 */
export const fetchUrlBytes = async (
  url: URL,
  options?: { timeoutMs?: number; headers?: Record<string, string> }
): Promise<FetchedBytes> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  );
  try {
    const res = await mediaFetch(url, {
      signal: controller.signal,
      headers: options?.headers,
    });
    if (!res.ok) {
      throw new Error(`URL fetch ${url.toString()} returned ${res.status}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") ?? undefined;
    return { data, mimeType };
  } finally {
    clearTimeout(timer);
  }
};
