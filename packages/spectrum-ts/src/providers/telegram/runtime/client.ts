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

// Mutating Bot API methods. Telegram's API does not provide an
// idempotency key, so the client cannot distinguish "request never reached
// Telegram" (safe to retry) from "Telegram processed it but the response /
// connection died" (retry creates duplicates). At the network layer that
// distinction is unobservable — both surface as the same `fetch` error,
// even genuine pre-header failures can race against header-arrival timing
// in practice. We therefore default to **at-most-once** semantics for
// mutating calls: only Telegram-instructed retries (429 with `retry_after`)
// are honored, since Telegram itself is asking us to retry there. Network
// errors and 5xx are NOT retried for mutating methods.
//
// Read methods (`getMe`, `getUpdates`, `getChat`, `getFile`) keep the full
// retry policy because they're idempotent: a duplicate read just costs one
// extra request and returns the same result.
//
// Method names are matched by prefix where it's safe to do so; an explicit
// entry is preferred for methods that don't fit a clean prefix.
const MUTATING_METHOD_PREFIXES = [
  "send",
  "edit",
  "delete",
  "forward",
  "copy",
  "pin",
  "unpin",
  "ban",
  "unban",
  "restrict",
  "promote",
  "approve",
  "decline",
  "answer",
  "set",
  "create",
  "close",
  "reopen",
  "stop",
  "leave",
  "uploadStickerFile",
  "addStickerToSet",
] as const;

const isMutatingMethod = (method: string): boolean => {
  for (const prefix of MUTATING_METHOD_PREFIXES) {
    if (method.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};

const policyForMethod = (method: string, base: RetryPolicy): RetryPolicy => {
  if (!isMutatingMethod(method)) {
    return base;
  }
  // 429 retry stays on (Telegram explicitly requested it via `retry_after`,
  // so duplicates are impossible by construction). Network and 5xx retry
  // are both off because either failure mode could have already been
  // processed by Telegram and the client cannot tell — without an
  // idempotency key we'd risk duplicate writes. At-most-once is the right
  // default for sends/edits/reactions; callers needing at-least-once can
  // retry explicitly with their own dedup story.
  return {
    ...base,
    retryNetworkErrors: false,
    retryServerErrors: false,
  };
};

// Combine an optional caller signal with an optional per-request timeout
// signal into a single signal we can pass to `fetch`. Filters undefineds,
// short-circuits to the original signal when only one is present, and
// otherwise delegates to the standard `AbortSignal.any()` (Node ≥20.4,
// Bun ≥1.0 — same baseline as `AbortSignal.timeout()` already used here).
//
// `AbortSignal.any` handles listener wiring + abort-reason propagation
// internally and registers itself as a weakref so the unused timeout
// signal becomes GC-eligible after the request settles. We deliberately
// drop the explicit `cleanup()` API the previous custom helper exposed:
// callers that previously had to invoke it are now inside try/finally
// blocks where the awaited operation settling is the cleanup boundary.
const combineSignals = (
  signals: (AbortSignal | undefined)[]
): AbortSignal | undefined => {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) {
    return;
  }
  if (present.length === 1) {
    return present[0];
  }
  return AbortSignal.any(present);
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
          // The combined signal stays in scope for the entire body read so
          // the per-request timeout and caller signal continue applying
          // after the headers arrive. A slow/stuck body would otherwise
          // hang the call indefinitely.
          const combined = combineSignals([signal, timeoutSignal]);

          let response: Response;
          try {
            response = await this.fetchImpl(url, {
              method: "POST",
              headers,
              body,
              signal: combined,
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
        },
        { policy: policyForMethod(method, this.retryPolicy), signal }
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
        const combined = combineSignals([signal, timeoutSignal]);

        let response: Response;
        try {
          response = await this.fetchImpl(url, { signal: combined });
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          throw new TelegramNetworkError("downloadFile", err);
        }

        if (!response.ok) {
          // Read the error body so the per-request timeout still applies to
          // the body read; a tiny JSON "description" is typical and far
          // more debuggable than a bare status code.
          const snippet = await readErrorSnippet(response);
          const base = `Telegram file download failed with HTTP ${response.status}`;
          throw new TelegramApiError({
            method: "downloadFile",
            errorCode: response.status,
            description: snippet ? `${base}: ${snippet}` : base,
          });
        }

        // The combined signal remains effective for the body stream because
        // `fetch` keeps it referenced internally until the body is fully
        // consumed (or aborted). No explicit body wrapping needed: the
        // `AbortSignal.any` wiring releases its own listeners on the source
        // signals as soon as the request settles.
        return response;
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

const migrationTargetFor = (err: unknown): number | undefined => {
  if (!(err instanceof TelegramApiError)) {
    return undefined;
  }
  return err.migrateToChatId;
};
