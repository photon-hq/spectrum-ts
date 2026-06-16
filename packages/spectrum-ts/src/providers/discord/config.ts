import z from "zod";

/**
 * The platform identifier — used for ALL THREE of:
 *
 * - the `definePlatform` name (so `message.platform` / `__platform` and
 *   the `platformStates` key are this value),
 * - the `fusor(...)` routing key the handler is registered under, and
 * - the value Fusor tags inbound Discord events with (`event.platform`).
 *
 * Spectrum's webhook delivery looks the runtime up by `event.platform` against
 * the platform name (`platformStates.get(event.platform)`), while routing is by
 * the fusor key — so these MUST be the same string. It must also match Fusor's
 * configured platform identifier for Discord (the `<platform>` path segment
 * the relayed event is delivered under).
 */
export const DISCORD_PLATFORM = "discord";

/** Default Discord API origin; override via `config.baseUrl` for a local test server. */
export const DEFAULT_BASE_URL = "https://discord.com/api/v10";

/**
 * Application (client) IDs are Discord snowflakes — purely numeric. Validating
 * the shape fails fast on a malformed id instead of producing bad API URLs.
 */
const APPLICATION_ID_PATTERN = /^\d+$/;

/**
 * Bot tokens are three base64url segments separated by dots
 * (`<base64 app id>.<timestamp>.<hmac>`). Validating the shape fails fast on a
 * malformed token instead of silently issuing unauthenticated API calls.
 */
const BOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const configSchema = z.object({
  /** Bot token from the Discord Developer Portal (outbound API calls + media downloads). */
  botToken: z
    .string()
    .regex(
      BOT_TOKEN_PATTERN,
      "botToken must be in the form '<id>.<ts>.<hmac>'"
    ),
  /**
   * The application's own snowflake id. For a bot account this equals the bot
   * user's id, so it is used to drop inbound events the bot itself produced (so
   * a bot never echoes its own sends). Modern bot tokens no longer encode it, so
   * it is supplied explicitly.
   */
  applicationId: z
    .string()
    .regex(APPLICATION_ID_PATTERN, "applicationId must be a numeric snowflake"),
  /** Override the Discord API base URL. Defaults to `https://discord.com/api/v10`. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
});

export type DiscordConfig = z.infer<typeof configSchema>;
