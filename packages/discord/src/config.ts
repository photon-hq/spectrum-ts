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

/** Discord caps each explicit mention allow-list at 100 ids. */
const MENTION_LIST_MAX = 100;

/**
 * Discord's `allowed_mentions` object — controls which mentions in an outbound
 * message actually ping. `parse` whitelists mention *types*
 * (`"users"`/`"roles"`/`"everyone"`); `users`/`roles` instead whitelist specific
 * ids (mutually exclusive with the matching `parse` entry — Discord 400s if you
 * set both). `replied_user` controls whether a reply pings the message it
 * replies to. Set on `config.allowedMentions` it applies to every outbound
 * message, letting a bot suppress `@everyone`/role pings globally. The provider
 * defaults `replied_user` to `false` so a reply never pings the author unless you
 * opt back in here.
 * https://discord.com/developers/docs/resources/message#allowed-mentions-object
 */
export const allowedMentionsSchema = z
  .object({
    parse: z.array(z.enum(["users", "roles", "everyone"])).optional(),
    roles: z
      .array(
        z
          .string()
          .regex(APPLICATION_ID_PATTERN, "role id must be a numeric snowflake")
      )
      .max(MENTION_LIST_MAX, `at most ${MENTION_LIST_MAX} role ids`)
      .optional(),
    users: z
      .array(
        z
          .string()
          .regex(APPLICATION_ID_PATTERN, "user id must be a numeric snowflake")
      )
      .max(MENTION_LIST_MAX, `at most ${MENTION_LIST_MAX} user ids`)
      .optional(),
    replied_user: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    // Discord rejects pinning a type both broadly (via `parse`) and to an id
    // list — catch it here with a clear message instead of as a 400 at send time.
    if (
      value.parse?.includes("users") &&
      value.users &&
      value.users.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["users"],
        message:
          "allowedMentions cannot set both parse:'users' and an explicit users list — they are mutually exclusive.",
      });
    }
    if (
      value.parse?.includes("roles") &&
      value.roles &&
      value.roles.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message:
          "allowedMentions cannot set both parse:'roles' and an explicit roles list — they are mutually exclusive.",
      });
    }
  });

export type AllowedMentions = z.infer<typeof allowedMentionsSchema>;

export const configSchema = z.object({
  /** Bot token from the Discord Developer Portal (outbound API calls + media downloads). */
  botToken: z
    .string()
    .regex(
      BOT_TOKEN_PATTERN,
      "botToken must be in the form '<id>.<ts>.<hmac>'. Get this token from Discord's Developer Portal."
    ),
  /**
   * The application's own snowflake id. For a bot account this equals the bot
   * user's id, so it is used to drop inbound events the bot itself produced (so
   * a bot never echoes its own sends). Modern bot tokens no longer encode it, so
   * it is supplied explicitly.
   */
  applicationId: z
    .string()
    .regex(
      APPLICATION_ID_PATTERN,
      "applicationId must be a numeric snowflake. Get this ID from Discord's Developer Portal."
    ),
  /** Override the Discord API base URL. Defaults to `https://discord.com/api/v10`. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  /**
   * Default `allowed_mentions` applied to every outbound message — restrict which
   * mentions ping (e.g. `{ parse: [] }` to mute all, or `{ parse: ["users"] }` to
   * allow only user mentions). Regardless of this, the provider defaults
   * `replied_user` to `false` so a reply never pings the author; set
   * `replied_user: true` here to restore it. A per-message override is still
   * possible via `custom` content carrying its own `allowed_mentions`.
   */
  allowedMentions: allowedMentionsSchema.optional(),
});

export type DiscordConfig = z.infer<typeof configSchema>;
