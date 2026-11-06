import { tracedFetch } from "@spectrum-ts/core/authoring";
import { WeChatApiError } from "./errors";
import type {
  GetConfigResponse,
  GetUpdatesResponse,
  ILinkResult,
  QrCodeResponse,
  QrStatusResponse,
  SendMessageResponse,
  WeixinMessage,
} from "./types";

// ---------------------------------------------------------------------------
// Client identity. `iLink-App-Id`, the `0x00MMNNPP` client-version encoding
// and `base_info` follow Tencent's protocol reference. iLink documents no
// compatibility signal other than the version, so this client reports the
// openclaw-weixin release whose wire format it implements, and names itself
// in `bot_agent` (iLink's User-Agent-style observability field).
// ---------------------------------------------------------------------------

export const ILINK_APP_ID = "bot";
export const ILINK_PROTOCOL_VERSION = "2.4.10";
export const BOT_AGENT = "spectrum-ts";
/** `bot_type` for the QR login endpoints (personal-WeChat bot). */
export const ILINK_BOT_TYPE = "3";

const DEFAULT_TIMEOUT_MS = 15_000;
const TRAILING_SLASHES = /\/+$/;
// The QR `qrcode` query value is a live login handle; keep it off spans.
const QR_CODE_QUERY = /([?&]qrcode=)[^&]*/;
// iLink ids are uint64 and JSON.parse rounds them past 2^53, so quote them
// before parsing. Inside a JSON string every `"` is escaped, so an unescaped
// `"message_id"` followed by `:` can only be an object key.
const UINT64_ID_FIELD = /(?<!\\)"(message_id|msg_id|svr_id)"(\s*:\s*)(-?\d+)/g;

const encodeClientVersion = (version: string): number => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major * 65_536 + minor * 256 + patch;
};

const APP_HEADERS = {
  "iLink-App-Id": ILINK_APP_ID,
  "iLink-App-ClientVersion": String(
    encodeClientVersion(ILINK_PROTOCOL_VERSION)
  ),
} as const;

const BASE_INFO = {
  channel_version: ILINK_PROTOCOL_VERSION,
  bot_agent: BOT_AGENT,
} as const;

// Spectrum's own iLink requests, traced as CLIENT spans.
const ilinkFetch = tracedFetch("wechat", {
  redactUrl: (url) => url.replace(QR_CODE_QUERY, "$1<redacted>"),
});

/** Parse an iLink response body, keeping uint64 id fields exact as strings. */
export const parseILinkJson = <T>(raw: string): T =>
  JSON.parse(raw.replace(UINT64_ID_FIELD, '"$1"$2"$3"')) as T;

/** `X-WECHAT-UIN`: a random uint32, as a decimal string, base64-encoded. */
const randomUin = (): string => {
  const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
  return Buffer.from(String(value)).toString("base64");
};

const jsonHeaders = (botToken?: string): Record<string, string> => ({
  ...APP_HEADERS,
  "Content-Type": "application/json",
  AuthorizationType: "ilink_bot_token",
  "X-WECHAT-UIN": randomUin(),
  ...(botToken ? { Authorization: `Bearer ${botToken}` } : {}),
});

export interface RequestOptions {
  /** Cancels the request (e.g. on shutdown); combined with the timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The authenticated bot an API call acts as. */
export interface ApiTarget {
  baseUrl: string;
  botToken: string;
}

/** True when a request was cut off by its own `timeoutMs`. */
export const isTimeoutError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "TimeoutError";

const requestSignal = ({
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RequestOptions): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const endpointName = (path: string): string =>
  path.split("?")[0]?.split("/").at(-1) ?? path;

const request = async <T>(
  baseUrl: string,
  path: string,
  init: RequestInit
): Promise<T> => {
  const url = `${baseUrl.replace(TRAILING_SLASHES, "")}/${path}`;
  const response = await ilinkFetch(url, init);
  const raw = await response.text();
  if (!response.ok) {
    throw new WeChatApiError({
      endpoint: endpointName(path),
      status: response.status,
    });
  }
  return raw ? parseILinkJson<T>(raw) : ({} as T);
};

/** Throw `WeChatApiError` when an iLink result carries a non-zero code. */
export const assertOk = <T extends ILinkResult>(
  endpoint: string,
  result: T
): T => {
  const failed =
    (result.ret !== undefined && result.ret !== 0) ||
    (result.errcode !== undefined && result.errcode !== 0);
  if (failed) {
    throw new WeChatApiError({
      endpoint,
      ret: result.ret,
      errcode: result.errcode,
      errmsg: result.errmsg,
    });
  }
  return result;
};

const botPost = async <T extends ILinkResult>(
  target: ApiTarget,
  path: string,
  body: Record<string, unknown>,
  options: RequestOptions = {}
): Promise<T> =>
  assertOk(
    endpointName(path),
    await request<T>(target.baseUrl, path, {
      method: "POST",
      headers: jsonHeaders(target.botToken),
      body: JSON.stringify({ ...body, base_info: BASE_INFO }),
      signal: requestSignal(options),
    })
  );

/** Long-poll for inbound messages after `cursor` (`""` on first use). */
export const getUpdates = (
  target: ApiTarget,
  cursor: string,
  options: RequestOptions
): Promise<GetUpdatesResponse> =>
  botPost(target, "ilink/bot/getupdates", { get_updates_buf: cursor }, options);

export const sendMessage = (
  target: ApiTarget,
  msg: WeixinMessage,
  options?: RequestOptions
): Promise<SendMessageResponse> =>
  botPost(target, "ilink/bot/sendmessage", { msg }, options);

/** The per-user ticket `sendtyping` requires. */
export const getTypingTicket = async (
  target: ApiTarget,
  userId: string,
  contextToken: string | undefined,
  options?: RequestOptions
): Promise<string | undefined> => {
  const response = await botPost<GetConfigResponse>(
    target,
    "ilink/bot/getconfig",
    { ilink_user_id: userId, context_token: contextToken },
    options
  );
  return response.typing_ticket || undefined;
};

export const sendTyping = async (
  target: ApiTarget,
  userId: string,
  typingTicket: string,
  status: number,
  options?: RequestOptions
): Promise<void> => {
  await botPost(
    target,
    "ilink/bot/sendtyping",
    { ilink_user_id: userId, typing_ticket: typingTicket, status },
    options
  );
};

/** Tell iLink this client started (Tencent's client calls it on connect). */
export const notifyStart = async (
  target: ApiTarget,
  options?: RequestOptions
): Promise<void> => {
  await botPost(target, "ilink/bot/msg/notifystart", {}, options);
};

/** Tell iLink this client is stopping. */
export const notifyStop = async (
  target: ApiTarget,
  options?: RequestOptions
): Promise<void> => {
  await botPost(target, "ilink/bot/msg/notifystop", {}, options);
};

/** Start a QR login: unauthenticated, and without `base_info`. */
export const getBotQrCode = (
  baseUrl: string,
  options: RequestOptions = {}
): Promise<QrCodeResponse> =>
  request(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ local_token_list: [] }),
    signal: requestSignal(options),
  });

/** Long-poll a QR login's status; only the app headers are sent. */
export const getQrCodeStatus = (
  baseUrl: string,
  qrcode: string,
  verifyCode: string | undefined,
  options: RequestOptions = {}
): Promise<QrStatusResponse> => {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) {
    query.set("verify_code", verifyCode);
  }
  return request(baseUrl, `ilink/bot/get_qrcode_status?${query}`, {
    method: "GET",
    headers: { ...APP_HEADERS },
    signal: requestSignal(options),
  });
};
