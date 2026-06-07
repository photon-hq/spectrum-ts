import { botIdFromToken, type TelegramConfig } from "./config";
import type { TelegramSendSpec } from "./types";

const CLIENT_STORE_KEY = "telegram.client";
const REQUEST_TIMEOUT_MS = 30_000;
const TRAILING_SLASHES = /\/+$/;

interface BotApiResponse<T> {
  description?: string;
  error_code?: number;
  ok: boolean;
  result?: T;
}

/**
 * The adapter's view of the Telegram Bot API. The Bot API is plain HTTP/JSON,
 * so this wraps the global `fetch` directly (no SDK): `call` executes any
 * method (JSON, or `multipart/form-data` when a file is attached) and unwraps
 * the `{ ok, result }` envelope; `download` resolves a `file_id` to bytes.
 */
export interface TelegramClient {
  /** The bot's own numeric id (token prefix), used to drop self-authored updates. */
  readonly botId: string;
  /** Execute one Bot API method and return its unwrapped `result`. */
  call<T = unknown>(spec: TelegramSendSpec): Promise<T>;
  /** Fetch a file's bytes by `file_id` (`getFile` → token URL → bytes). */
  download(fileId: string): Promise<Buffer>;
}

const toFormValue = (value: unknown): string =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

const buildBody = (
  spec: TelegramSendSpec
): { body: string | FormData; headers?: Record<string, string> } => {
  if (!spec.file) {
    return {
      body: JSON.stringify(spec.params),
      headers: { "content-type": "application/json" },
    };
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(spec.params)) {
    if (value === undefined || value === null) {
      continue;
    }
    form.append(key, toFormValue(value));
  }
  const blob = new Blob([new Uint8Array(spec.file.bytes)], {
    type: spec.file.mimeType,
  });
  form.append(spec.file.field, blob, spec.file.filename);
  return { body: form };
};

const makeTelegramClient = (config: TelegramConfig): TelegramClient => {
  const base = config.baseUrl.replace(TRAILING_SLASHES, "");
  const token = config.botToken;

  const call = async <T = unknown>(spec: TelegramSendSpec): Promise<T> => {
    const { body, headers } = buildBody(spec);
    const res = await fetch(`${base}/bot${token}/${spec.method}`, {
      method: "POST",
      ...(headers ? { headers } : {}),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Read the body as text first: an upstream proxy (or a custom `baseUrl`
    // test server) can return a non-JSON error page, and an unguarded
    // `res.json()` would throw an opaque parse error that hides the method and
    // status. Never include the URL (it carries the bot token) in errors.
    const raw = await res.text();
    let json: BotApiResponse<T> | undefined;
    try {
      json = raw ? (JSON.parse(raw) as BotApiResponse<T>) : undefined;
    } catch {
      throw new Error(
        `Telegram ${spec.method} failed: ${res.status} ${res.statusText}`
      );
    }
    if (!json?.ok) {
      throw new Error(
        `Telegram ${spec.method} failed: ${json?.error_code ?? res.status} ${json?.description ?? res.statusText}`
      );
    }
    return json.result as T;
  };

  const download = async (fileId: string): Promise<Buffer> => {
    const file = await call<{ file_path?: string }>({
      method: "getFile",
      params: { file_id: fileId },
    });
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
    }
    // The file URL embeds the bot token — keep it out of logs/errors.
    const res = await fetch(`${base}/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `Telegram media download failed: ${res.status} ${res.statusText}`
      );
    }
    return Buffer.from(await res.arrayBuffer());
  };

  return { botId: botIdFromToken(token), call, download };
};

// Store is an SDK-internal KV reachable through lifecycle/send ctx. It isn't
// exported from spectrum-ts, so we depend on its minimal structural shape.
export interface StoreLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Build the client once (in `createClient`) and cache it on `store`. */
export const initClient = (
  store: StoreLike,
  config: TelegramConfig
): TelegramClient => {
  const client = makeTelegramClient(config);
  store.set(CLIENT_STORE_KEY, client);
  return client;
};

/** Read the cached client in `send`/actions, rebuilding it if absent. */
export const getClient = (
  store: StoreLike,
  config: TelegramConfig
): TelegramClient =>
  (store.get(CLIENT_STORE_KEY) as TelegramClient | undefined) ??
  initClient(store, config);
