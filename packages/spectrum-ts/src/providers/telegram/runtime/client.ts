import type { MethodName, Methods } from "../generated/methods";
import { BASE_URL } from "../generated/methods";
import { TelegramApiError, TelegramNetworkError } from "./errors";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, withRetry } from "./retry";

export interface TelegramClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request deadline in ms. Null disables the timeout. Default: 60_000. */
  requestTimeoutMs?: number | null;
  retry?: Partial<RetryPolicy>;
  token: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface MergedSignal {
  /** Always call once the awaited operation settles so listeners on caller
   * signals don't leak on the happy path. Safe to call multiple times. */
  cleanup: () => void;
  signal: AbortSignal | undefined;
}

const mergeSignals = (signals: (AbortSignal | undefined)[]): MergedSignal => {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (present.length === 1) {
    return { signal: present[0], cleanup: () => {} };
  }
  const controller = new AbortController();
  const handlers: { signal: AbortSignal; handler: () => void }[] = [];
  const cleanup = () => {
    for (const { signal, handler } of handlers) {
      signal.removeEventListener("abort", handler);
    }
    handlers.length = 0;
  };
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      cleanup();
      return { signal: controller.signal, cleanup: () => {} };
    }
    const handler = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    handlers.push({ signal, handler });
    signal.addEventListener("abort", handler, { once: true });
  }
  return { signal: controller.signal, cleanup };
};

interface ApiResponseOk<T> {
  ok: true;
  result: T;
}

interface ApiResponseErr {
  description: string;
  error_code: number;
  ok: false;
  parameters?: import("../generated/types").ResponseParameters;
}

type ApiResponse<T> = ApiResponseOk<T> | ApiResponseErr;

// Returns true iff a top-level field is a Blob. Nested Blobs (inside arrays
// or objects) are intentionally rejected by `assertNoNestedBlob` rather than
// silently triggering multipart and then being JSON.stringify()'d into the
// parent field.
//
// ReadableStream is also rejected at the same boundary: appendFormField only
// emits raw parts for Blobs, so a stream value would either be dropped here
// or serialise to "{}" inside a JSON field — both silent data losses worse
// than a loud error.
const hasTopLevelBlob = (params: Record<string, unknown>): boolean => {
  for (const value of Object.values(params)) {
    if (value instanceof Blob) {
      return true;
    }
  }
  return false;
};

// Walk into arrays/objects looking for embedded Blobs or ReadableStreams. The
// only legitimate place for a Blob in a Telegram method today is at the top
// level (`photo`, `video`, `voice`, etc. on `sendPhoto`/`sendVideo`/...).
// `sendMediaGroup` *would* need a real `attach://` encoding for nested Blobs;
// when we add it we'll lift this restriction with explicit support, not by
// silently allowing the corruption-prone JSON.stringify path.
const assertNoNestedBlob = (
  method: string,
  value: unknown,
  path: string
): void => {
  if (value === null || value === undefined) {
    return;
  }
  if (value instanceof Blob) {
    throw new Error(
      `Telegram client cannot serialize Blob at "${path}" of ${method} request: ` +
        "nested binary fields are not supported. Pass binaries at the top " +
        "level (e.g. sendPhoto({ photo: blob })) instead."
    );
  }
  if (value instanceof ReadableStream) {
    throw new Error(
      `Telegram client cannot serialize ReadableStream at "${path}" of ${method} request: ` +
        "stream uploads are not supported. Buffer into a Blob first."
    );
  }
  if (Array.isArray(value)) {
    for (const [idx, item] of value.entries()) {
      assertNoNestedBlob(method, item, `${path}[${idx}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      assertNoNestedBlob(method, child, `${path}.${key}`);
    }
  }
};

// Nested objects/arrays must be JSON-encoded strings inside multipart fields;
// only top-level Blobs are attached as raw parts. `assertNoNestedBlob` runs
// before this so any nested Blob has already failed the request loudly.
const appendFormField = (form: FormData, key: string, value: unknown): void => {
  if (value === undefined || value === null) {
    return;
  }
  if (value instanceof Blob) {
    form.append(key, value);
    return;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    form.append(key, String(value));
    return;
  }
  form.append(key, JSON.stringify(value));
};

const buildBody = (
  method: string,
  params: Record<string, unknown>
): { body: string | FormData; headers: Record<string, string> } => {
  // Walk every top-level value's interior first so any embedded Blob or
  // ReadableStream surfaces as a clear error before we pick a transport.
  for (const [key, value] of Object.entries(params)) {
    if (!(value instanceof Blob)) {
      assertNoNestedBlob(method, value, key);
    }
  }
  if (hasTopLevelBlob(params)) {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      appendFormField(form, key, value);
    }
    return { body: form, headers: {} };
  }
  return {
    body: JSON.stringify(params),
    headers: { "content-type": "application/json" },
  };
};

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number | null;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
    this.fetchImpl = opts.fetch ?? fetch;
    this.requestTimeoutMs =
      opts.requestTimeoutMs === undefined
        ? DEFAULT_REQUEST_TIMEOUT_MS
        : opts.requestTimeoutMs;
  }

  async invoke<M extends MethodName>(
    method: M,
    params: Methods[M]["params"],
    signal?: AbortSignal
  ): Promise<Methods[M]["result"]> {
    return await this.invokeOnce(method, params, signal, /*migrations*/ 0);
  }

  private async invokeOnce<M extends MethodName>(
    method: M,
    params: Methods[M]["params"],
    signal: AbortSignal | undefined,
    migrations: number
  ): Promise<Methods[M]["result"]> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const { body, headers } = buildBody(
      method,
      params as Record<string, unknown>
    );

    try {
      return await withRetry(
        async () => {
          const timeoutSignal =
            this.requestTimeoutMs === null
              ? undefined
              : AbortSignal.timeout(this.requestTimeoutMs);
          const merged = mergeSignals([signal, timeoutSignal]);

          // `cleanup()` must stay deferred until the response body is fully
          // consumed — otherwise the per-request timeout and caller signal
          // stop applying once the headers arrive, and a slow/stuck body can
          // hang the call indefinitely.
          try {
            let response: Response;
            try {
              response = await this.fetchImpl(url, {
                method: "POST",
                headers,
                body,
                signal: merged.signal,
              });
            } catch (err) {
              if (signal?.aborted) {
                throw err;
              }
              throw new TelegramNetworkError(method, err);
            }

            let payload: ApiResponse<Methods[M]["result"]>;
            try {
              payload = (await response.json()) as ApiResponse<
                Methods[M]["result"]
              >;
            } catch (err) {
              throw new TelegramNetworkError(method, err);
            }

            if (!payload.ok) {
              throw new TelegramApiError({
                method,
                errorCode: payload.error_code,
                description: payload.description,
                parameters: payload.parameters,
              });
            }

            return payload.result;
          } finally {
            merged.cleanup();
          }
        },
        { policy: this.retryPolicy, signal }
      );
    } catch (err) {
      const newChatId = migrationTargetFor(err);
      if (newChatId !== undefined && migrations < 1) {
        const migrated = {
          ...(params as Record<string, unknown>),
          chat_id: newChatId,
        } as Methods[M]["params"];
        return await this.invokeOnce(method, migrated, signal, migrations + 1);
      }
      throw err;
    }
  }

  fileUrl(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.token}/${filePath}`;
  }

  // Downloads a Telegram-hosted file through the same transport used by
  // `invoke()` so that `TelegramClientOptions.fetch`, per-request timeouts,
  // and retry/backoff apply uniformly to media reads.
  async downloadFile(
    filePath: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const url = this.fileUrl(filePath);
    return await withRetry(
      async () => {
        const timeoutSignal =
          this.requestTimeoutMs === null
            ? undefined
            : AbortSignal.timeout(this.requestTimeoutMs);
        const merged = mergeSignals([signal, timeoutSignal]);

        let response: Response;
        try {
          response = await this.fetchImpl(url, { signal: merged.signal });
        } catch (err) {
          merged.cleanup();
          if (signal?.aborted) {
            throw err;
          }
          throw new TelegramNetworkError("downloadFile", err);
        }

        if (!response.ok) {
          // Read the error body before cleanup so the per-request timeout
          // still applies to the body read; a tiny JSON "description" is
          // typical and far more debuggable than a bare status code.
          const snippet = await readErrorSnippet(response);
          merged.cleanup();
          const base = `Telegram file download failed with HTTP ${response.status}`;
          throw new TelegramApiError({
            method: "downloadFile",
            errorCode: response.status,
            description: snippet ? `${base}: ${snippet}` : base,
          });
        }

        // Keep the merged signal live until the caller finishes consuming the
        // response body — otherwise the per-request timeout and caller signal
        // stop applying mid-transfer. We wrap the body so cleanup runs exactly
        // once whether the stream completes, errors, or is cancelled. For
        // bodyless responses, clean up immediately.
        return wrapResponseForCleanup(response, merged.cleanup);
      },
      { policy: this.retryPolicy, signal }
    );
  }
}

const ERROR_SNIPPET_MAX_LEN = 200;

// Best-effort body read for error messages. Returns undefined on empty bodies
// or read failures — callers fall back to a bare status-code message.
const readErrorSnippet = async (
  response: Response
): Promise<string | undefined> => {
  try {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    return text.length > ERROR_SNIPPET_MAX_LEN
      ? `${text.slice(0, ERROR_SNIPPET_MAX_LEN)}…`
      : text;
  } catch {
    return undefined;
  }
};

const wrapResponseForCleanup = (
  response: Response,
  cleanup: () => void
): Response => {
  let done = false;
  const runOnce = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
  };

  const body = response.body;
  if (!body) {
    runOnce();
    return response;
  }

  // `TransformStream` transformers expose only `start/transform/flush` — no
  // `cancel` hook — so we wrap the body in a ReadableStream adapter whose
  // `pull`/`cancel` fire cleanup exactly once whether the stream completes,
  // errors, or the consumer aborts mid-read.
  const reader = body.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          controller.close();
          runOnce();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // Best-effort cancel on the underlying reader so the body stream
        // unlocks immediately instead of waiting for GC. The caller-facing
        // error is whatever `reader.read()` threw; cancellation failure
        // here is incidental and should not mask that.
        reader.cancel(err).catch(() => {
          /* swallow — primary error is already routed via controller.error */
        });
        controller.error(err);
        runOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        runOnce();
      }
    },
  });
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const migrationTargetFor = (err: unknown): number | undefined => {
  if (!(err instanceof TelegramApiError)) {
    return undefined;
  }
  return err.migrateToChatId;
};
