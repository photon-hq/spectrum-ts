import { createTelegramClient, getFile } from "@photon-ai/telegram-ts";
import { tracedFetch } from "@spectrum-ts/core/authoring";
import type { TelegramConfig } from "./config";
import type { SentMessage, TelegramSendSpec } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const TRAILING_SLASHES = /\/+$/;
// The `/file/bot<token>` path segment of a Telegram file-download URL. Anchored
// on `/file/` so a base whose host starts with `bot` (e.g. bot-proxy.example)
// can't match the host instead of the token.
const BOT_TOKEN_SEGMENT = /\/file\/bot[^/]+/;

/**
 * Mask the bot token embedded in a Telegram file URL path before it is recorded
 * on a span (`/file/bot<token>/…` → `/file/bot<redacted>/…`). The real download
 * still uses the true URL — only the span's `url.full` is masked.
 */
export const redactBotToken = (url: string): string =>
  url.replace(BOT_TOKEN_SEGMENT, "/file/bot<redacted>");

// Spectrum's Telegram media downloads, traced as CLIENT spans with the bot
// token redacted from the recorded URL.
const mediaFetch = tracedFetch("telegram", { redactUrl: redactBotToken });

/**
 * A photon Bot API client (hey-api `Client`). Created per request — the
 * constructor makes no network call, so there is nothing to cache. Sending and
 * inbound media download each build one inline from `config`.
 */
export type TelegramClient = ReturnType<typeof createTelegramClient>;

/** Build a photon client bound to the bot token. Cheap: no network on construction. */
export const telegramClient = (config: TelegramConfig): TelegramClient =>
  createTelegramClient({ token: config.botToken, baseUrl: config.baseUrl });

// photon's typed `send*` methods only accept a string file ref (file_id/URL) and
// it does not export its form serializer, so raw-byte uploads go through the
// low-level `client.post` with this serializer — modeled on photon's internal
// `formDataBodySerializer` (string/Blob verbatim, Date → ISO, else JSON). Unlike
// photon, an array/object is appended as a single JSON-encoded part: Telegram's
// multipart fields (e.g. `caption_entities`, `media`) must be one JSON value, not
// one part per element.
const appendFormValue = (form: FormData, key: string, value: unknown): void => {
  if (typeof value === "string" || value instanceof Blob) {
    form.append(key, value);
  } else if (value instanceof Date) {
    form.append(key, value.toISOString());
  } else {
    form.append(key, JSON.stringify(value));
  }
};

const toFormData = (body: unknown): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      continue;
    }
    appendFormValue(form, key, value);
  }
  return form;
};

/** The `{ ok, result }` envelope photon resolves to with `responseStyle: "data"`. */
interface SendEnvelope {
  result: SentMessage;
}

/**
 * Execute one Bot API call through the photon client and return the sent
 * message. JSON params go out as `application/json`; a `file` is uploaded as
 * `multipart/form-data` — wrapped in a `File` so the part keeps its filename
 * (`formDataBodySerializer` appends without an explicit name), with
 * `Content-Type: null` dropping the default JSON header so fetch sets the
 * multipart boundary. A failed call throws `TelegramApiError` (token-free).
 */
export const executeSpec = async (
  client: TelegramClient,
  spec: TelegramSendSpec
): Promise<SentMessage> => {
  const url = `/${spec.method}`;
  if (spec.file) {
    const file = new File(
      [new Uint8Array(spec.file.bytes)],
      spec.file.filename,
      { type: spec.file.mimeType }
    );
    const res = await client.post({
      body: { ...spec.params, [spec.file.field]: file },
      bodySerializer: toFormData,
      headers: { "Content-Type": null },
      throwOnError: true,
      url,
    });
    return (res.data as SendEnvelope).result;
  }
  const res = await client.post({ body: spec.params, throwOnError: true, url });
  return (res.data as SendEnvelope).result;
};

/**
 * Resolve a `file_id` to its bytes. photon has no byte-download helper and the
 * file endpoint is not a Bot API JSON method, so this is the one place that
 * reaches Telegram outside photon: `getFile` (via photon) for the path, then a
 * single authenticated `fetch`. The file URL embeds the bot token, so it is
 * never interpolated into a thrown error.
 */
export const downloadFile = async (
  config: TelegramConfig,
  fileId: string
): Promise<Buffer> => {
  const client = telegramClient(config);
  const meta = await getFile({
    body: { file_id: fileId },
    client,
    throwOnError: true,
  });
  const filePath = meta.result?.file_path;
  if (!filePath) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }
  const base = config.baseUrl.replace(TRAILING_SLASHES, "");
  const res = await mediaFetch(
    `${base}/file/bot${config.botToken}/${filePath}`,
    {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new Error(
      `Telegram media download failed: ${res.status} ${res.statusText}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
};
