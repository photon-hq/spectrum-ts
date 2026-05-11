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

// Telegram has no idempotency key, so mutating methods get at-most-once
// semantics: 429 retries only (server explicitly asks via `retry_after`).
// Reads keep the full policy.
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
  return {
    ...base,
    retryNetworkErrors: false,
    retryServerErrors: false,
  };
};

// Recognise aborts — either caller-driven cancellations or the internal
// request-timeout — so they propagate as control flow instead of being
// wrapped in `TelegramNetworkError` (which would trigger retries).
// `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`
// on Node/undici, so both names are treated as terminal aborts.
const isAbortLike = (err: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) {
    return true;
  }
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return false;
  }
  const name = (err as { name: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
};

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

const hasTopLevelBlob = (params: Record<string, unknown>): boolean => {
  for (const value of Object.values(params)) {
    if (value instanceof Blob) {
      return true;
    }
  }
  return false;
};

// `appendFormField` JSON-stringifies non-primitive values, which would
// silently drop binary content if a `Blob` were nested inside an object or
// array. Telegram's Bot API only accepts `InputFile`s at the top level of
// the multipart body, so a nested `Blob` is always a caller bug — fail
// loudly instead of letting it serialize to "{}".
const containsBlobDeep = (value: unknown): boolean => {
  if (value instanceof Blob) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsBlobDeep);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      containsBlobDeep
    );
  }
  return false;
};

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
  params: Record<string, unknown>
): { body: string | FormData; headers: Record<string, string> } => {
  if (hasTopLevelBlob(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (!(value instanceof Blob) && containsBlobDeep(value)) {
        throw new Error(
          `Telegram client: parameter "${key}" contains a nested Blob; lift uploads into top-level multipart fields`
        );
      }
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      appendFormField(form, key, value);
    }
    return { body: form, headers: {} };
  }
  if (containsBlobDeep(params)) {
    throw new Error(
      "Telegram client: request params contain a nested Blob; lift uploads into top-level multipart fields"
    );
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
    const token = typeof opts.token === "string" ? opts.token.trim() : "";
    if (!token) {
      throw new Error(
        "TelegramClient: token is required and cannot be empty or whitespace"
      );
    }
    this.token = token;
    this.baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, "");
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
    this.fetchImpl = opts.fetch ?? fetch;
    const requestTimeoutMs =
      opts.requestTimeoutMs === undefined
        ? DEFAULT_REQUEST_TIMEOUT_MS
        : opts.requestTimeoutMs;
    if (
      requestTimeoutMs !== null &&
      (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 0)
    ) {
      throw new RangeError(
        `TelegramClient.requestTimeoutMs must be null or a non-negative finite number; got ${String(requestTimeoutMs)}`
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async invoke<M extends MethodName>(
    method: M,
    params: Methods[M]["params"],
    signal?: AbortSignal
  ): Promise<Methods[M]["result"]> {
    // Timeout signal is built once per invoke so the deadline covers
    // retries, backoff, and any migration follow-ups.
    const timeoutSignal =
      this.requestTimeoutMs === null
        ? undefined
        : AbortSignal.timeout(this.requestTimeoutMs);
    const combined = combineSignals([signal, timeoutSignal]);
    return await this.invokeOnce(method, params, combined, 0);
  }

  private async invokeOnce<M extends MethodName>(
    method: M,
    params: Methods[M]["params"],
    combined: AbortSignal | undefined,
    migrations: number
  ): Promise<Methods[M]["result"]> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const { body, headers } = buildBody(params as Record<string, unknown>);

    try {
      return await withRetry(
        async () => {
          let response: Response;
          try {
            response = await this.fetchImpl(url, {
              method: "POST",
              headers,
              body,
              signal: combined,
            });
          } catch (err) {
            if (isAbortLike(err, combined)) {
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
            if (isAbortLike(err, combined)) {
              throw err;
            }
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
        { policy: policyForMethod(method, this.retryPolicy), signal: combined }
      );
    } catch (err) {
      const newChatId = migrationTargetFor(err);
      if (newChatId !== undefined && migrations < 1) {
        const migrated = {
          ...(params as Record<string, unknown>),
          chat_id: newChatId,
        } as Methods[M]["params"];
        return await this.invokeOnce(
          method,
          migrated,
          combined,
          migrations + 1
        );
      }
      throw err;
    }
  }

  fileUrl(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.token}/${filePath}`;
  }

  async downloadFile(
    filePath: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const url = this.fileUrl(filePath);
    const timeoutSignal =
      this.requestTimeoutMs === null
        ? undefined
        : AbortSignal.timeout(this.requestTimeoutMs);
    const combined = combineSignals([signal, timeoutSignal]);

    return await withRetry(
      async () => {
        let response: Response;
        try {
          response = await this.fetchImpl(url, { signal: combined });
        } catch (err) {
          if (isAbortLike(err, combined)) {
            throw err;
          }
          throw new TelegramNetworkError("downloadFile", err);
        }

        if (!response.ok) {
          const snippet = await readErrorSnippet(response, combined);
          if (combined?.aborted) {
            throw combined.reason ?? new DOMException("Aborted", "AbortError");
          }
          const base = `Telegram file download failed with HTTP ${response.status}`;
          throw new TelegramApiError({
            method: "downloadFile",
            errorCode: response.status,
            description: snippet ? `${base}: ${snippet}` : base,
          });
        }

        return response;
      },
      { policy: this.retryPolicy, signal: combined }
    );
  }
}

const ERROR_SNIPPET_MAX_LEN = 200;

const readErrorSnippet = async (
  response: Response,
  signal?: AbortSignal
): Promise<string | undefined> => {
  try {
    const text = await response.text();
    if (!text) {
      return;
    }
    return text.length > ERROR_SNIPPET_MAX_LEN
      ? `${text.slice(0, ERROR_SNIPPET_MAX_LEN)}…`
      : text;
  } catch (err) {
    if (isAbortLike(err, signal)) {
      throw err;
    }
    return;
  }
};

const migrationTargetFor = (err: unknown): number | undefined => {
  if (!(err instanceof TelegramApiError)) {
    return;
  }
  return err.migrateToChatId;
};
