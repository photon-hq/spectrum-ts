import z from "zod";

/**
 * The platform identifier: the `definePlatform` name, so `message.platform`,
 * the `platformStates` key and the `SPECTRUM_WECHAT_*` env prefix all derive
 * from it.
 */
export const WECHAT_PLATFORM = "wechat";

/** iLink bot API origin. QR login always starts here. */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** How long `createClient` waits for the QR code to be scanned and confirmed. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;

/**
 * Receives the content to show as a QR code during login (a URL that WeChat
 * opens when scanned). Render it however suits the host — a terminal QR, an
 * image in a web page, or just a link.
 */
export type QrCodeHandler = (qrCodeUrl: string) => void | Promise<void>;

/**
 * Asked for the number WeChat displays on the phone when the server requires
 * an extra verification step after the scan. Resolve with what the user typed.
 */
export type VerifyCodeHandler = () => string | Promise<string>;

const isFunction = (value: unknown): boolean => typeof value === "function";

export const loginSchema = z.object({
  /**
   * Called with each QR code to scan (again after a refresh). When omitted,
   * the URL is logged at `info` level.
   */
  onQrCode: z
    .custom<QrCodeHandler>(isFunction, "login.onQrCode must be a function")
    .optional(),
  /**
   * Called when WeChat asks for the verification number shown on the phone.
   * When omitted, a login that needs one fails with `WeChatLoginError`.
   */
  onVerifyCode: z
    .custom<VerifyCodeHandler>(
      isFunction,
      "login.onVerifyCode must be a function"
    )
    .optional(),
  timeoutMs: z.number().int().positive().default(DEFAULT_LOGIN_TIMEOUT_MS),
});

export type WeChatLoginConfig = z.infer<typeof loginSchema>;

export const configSchema = z.object({
  /**
   * iLink bot token from a previous QR login. Falls back to
   * `SPECTRUM_WECHAT_BOT_TOKEN`, then to the credentials saved in `stateFile`;
   * when none is available, `createClient` runs the QR login flow.
   */
  botToken: z.string().min(1).optional(),
  /**
   * iLink API origin used with an explicit `botToken`. Pass the `baseUrl`
   * returned by the login alongside its token. Falls back to
   * `SPECTRUM_WECHAT_BASE_URL`, then to `https://ilinkai.weixin.qq.com`.
   */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  /**
   * JSON file that keeps the login credentials, the `getupdates` cursor and
   * each user's latest `context_token` across restarts (written with mode
   * 0600). Without it this state lives only in memory for the process
   * lifetime. Falls back to `SPECTRUM_WECHAT_STATE_FILE`.
   */
  stateFile: z.string().min(1).optional(),
  /** QR login hooks, used only when no token is available. */
  login: loginSchema.prefault({}),
});

export type WeChatConfig = z.infer<typeof configSchema>;
