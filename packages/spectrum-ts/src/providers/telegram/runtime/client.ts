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

const containsBinary = (params: unknown): boolean => {
  if (params === null || typeof params !== "object") {
    return false;
  }
  // Keep in sync with appendFormField: only Blobs are attached as raw parts.
  // ReadableStream is intentionally not treated as binary — appendFormField
  // has no handler for it, so triggering multipart here would JSON.stringify
  // the stream into "{}" and silently drop the payload.
  if (params instanceof Blob) {
    return true;
  }
  if (Array.isArray(params)) {
    return params.some(containsBinary);
  }
  for (const value of Object.values(params as Record<string, unknown>)) {
    if (containsBinary(value)) {
      return true;
    }
  }
  return false;
};

// Nested objects/arrays must be JSON-encoded strings inside multipart fields;
// only Blobs are attached as raw parts.
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
  if (containsBinary(params)) {
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
    const { body, headers } = buildBody(params as Record<string, unknown>);

    try {
      return await withRetry(
        async () => {
          const timeoutSignal =
            this.requestTimeoutMs === null
              ? undefined
              : AbortSignal.timeout(this.requestTimeoutMs);
          const merged = mergeSignals([signal, timeoutSignal]);

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
          } finally {
            merged.cleanup();
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
          if (signal?.aborted) {
            throw err;
          }
          throw new TelegramNetworkError("downloadFile", err);
        } finally {
          merged.cleanup();
        }

        if (!response.ok) {
          throw new TelegramApiError({
            method: "downloadFile",
            errorCode: response.status,
            description: `Telegram file download failed with HTTP ${response.status}`,
          });
        }
        return response;
      },
      { policy: this.retryPolicy, signal }
    );
  }
}

const migrationTargetFor = (err: unknown): number | undefined => {
  if (!(err instanceof TelegramApiError)) {
    return undefined;
  }
  return err.migrateToChatId;
};
