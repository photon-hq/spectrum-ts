import z from "zod";

/**
 * The platform identifier — used for ALL THREE of:
 *
 * - the `definePlatform` name (so `message.platform` / `__platform` and
 *   the `platformStates` key are this value),
 * - the `fusor(...)` routing key the handler is registered under, and
 * - the value Fusor tags inbound Telegram events with (`event.platform`).
 *
 * Spectrum's webhook delivery looks the runtime up by `event.platform` against
 * the platform name (`platformStates.get(event.platform)`), while routing is by
 * the fusor key — so these MUST be the same string. It must also match Fusor's
 * configured platform identifier for Telegram (the `<platform>` path segment
 * the webhook is delivered under).
 */
export const TELEGRAM_PLATFORM = "telegram";

/** Default Bot API origin; override via `config.baseUrl` for a local test server. */
export const DEFAULT_BASE_URL = "https://api.telegram.org";

/**
 * Telegram's webhook secret token is echoed verbatim in a header, so it is
 * constrained to the header-safe character set documented for `setWebhook`.
 */
const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Bot tokens are `<numeric_id>:<auth_token>`. Validating the shape fails fast on
 * a malformed token instead of silently deriving a bad `botId` (token prefix)
 * and Bot API URLs from it.
 */
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

export const configSchema = z.object({
  /**
   * Bot token from @BotFather (outbound API calls + media downloads). Falls back
   * to `SPECTRUM_TELEGRAM_BOT_TOKEN` when omitted (explicit config wins).
   */
  botToken: z
    .string()
    .regex(BOT_TOKEN_PATTERN, "botToken must be in the form '<id>:<token>'"),
  /**
   * The `secret_token` passed to `setWebhook`. When present, inbound webhooks
   * are verified against the `X-Telegram-Bot-Api-Secret-Token` header; when
   * omitted, the check is skipped. Telegram does not HMAC-sign the body, so
   * this shared token is the only inbound authentication. Falls back to
   * `SPECTRUM_TELEGRAM_WEBHOOK_SECRET` when omitted.
   */
  webhookSecret: z.string().regex(SECRET_TOKEN_PATTERN).optional(),
  /**
   * Override the Bot API base URL. Precedence is explicit config >
   * `SPECTRUM_TELEGRAM_BASE_URL` > the `https://api.telegram.org` default.
   */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
});

export type TelegramConfig = z.infer<typeof configSchema>;

/**
 * The bot's own numeric id is the prefix of the token (`<id>:<hash>`). Used to
 * drop inbound updates the bot itself produced, so a bot never echoes its own
 * sends.
 */
export const botIdFromToken = (botToken: string): string =>
  botToken.split(":")[0] ?? "";
