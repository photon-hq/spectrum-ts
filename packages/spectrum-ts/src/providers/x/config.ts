import z from "zod";

/**
 * Platform identifier used by `definePlatform`, fusor routing, and the
 * super-webhook path segment.
 */
export const X_PLATFORM = "x";

/** Default X API origin. */
export const DEFAULT_BASE_URL = "https://api.x.com";

/** Default X OAuth2 token endpoint used for SDK-side refresh in BYO-app mode. */
export const DEFAULT_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";

const xUserIdField = z.string().regex(/^\d+$/, "xUserId must be numeric");

/** Tokens emitted by an SDK-side refresh, passed to `onTokensRefreshed`. */
export interface XRefreshedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

/**
 * BYO-app config: the customer brings their own X app. The SDK handles webhook
 * registration, CRC + signature verification, token refresh, and sends — all
 * with the customer's own credentials. No Spectrum-managed X credentials.
 */
export const directConfigSchema = z
  .object({
    /** App consumer secret used for webhook CRC + signature verification. */
    consumerSecret: z.string().min(1),
    /** User-context OAuth token used for outbound DMs + subscription call. */
    accessToken: z.string().min(1),
    /** Connected account id (numeric) used for echo filtering and routing. */
    xUserId: xUserIdField,
    /** App-only bearer used for webhook registration/list operations. */
    appBearerToken: z.string().min(1),
    /** App API key (consumer key); pairs with accessTokenSecret for OAuth 1.0a. */
    consumerKey: z.string().min(1).optional(),
    /** OAuth 1.0a access token secret; pairs with accessToken for user-context calls. */
    accessTokenSecret: z.string().min(1).optional(),
    /** Override the X API base URL for tests/local stubs. */
    baseUrl: z.url().default(DEFAULT_BASE_URL),
    /** Override the Fusor edge URL base (e.g. local ngrok) instead of {slug}.spctrm.dev. */
    webhookBaseUrl: z.string().url().optional(),
    // BYO-app OAuth2 credentials. When all three are present the SDK refreshes
    // the access token itself (timer + single-flight), calling X directly with
    // no Spectrum Cloud. Absent → `accessToken` is used as-is (caller-managed).
    /** BYO-app OAuth2 client id. */
    clientId: z.string().min(1).optional(),
    /** BYO-app OAuth2 client secret. */
    clientSecret: z.string().min(1).optional(),
    /** BYO-app rotating refresh token (requires offline.access). */
    refreshToken: z.string().min(1).optional(),
    /** X OAuth2 token endpoint (override for tests/proxies). */
    tokenUrl: z.url().default(DEFAULT_TOKEN_URL),
    /**
     * Called whenever the SDK rotates tokens. X refresh tokens are single-use,
     * so persist the new refresh token here to survive a process restart — the
     * originally-configured token is invalid after the first refresh.
     */
    onTokensRefreshed: z
      .custom<(tokens: XRefreshedTokens) => void | Promise<void>>(
        (value) => value === undefined || typeof value === "function"
      )
      .optional(),
  })
  .refine(
    (cfg) => {
      const provided = [
        cfg.clientId,
        cfg.clientSecret,
        cfg.refreshToken,
      ].filter(Boolean).length;
      return provided === 0 || provided === 3;
    },
    {
      message:
        "X SDK-side refresh requires all of clientId, clientSecret, and refreshToken (or none).",
    }
  );

export const configSchema = directConfigSchema;

export type XDirectConfig = z.infer<typeof directConfigSchema>;
/** Sole X config shape (BYO-app). Alias kept for call sites that import it. */
export type XConfig = XDirectConfig;

/** Direct config that carries a full BYO-app OAuth2 refresh credential set. */
export type XRefreshConfig = XDirectConfig & {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/** True when direct config has the creds for SDK-side token refresh. */
export const hasRefreshCreds = (
  config: XDirectConfig
): config is XRefreshConfig =>
  Boolean(config.clientId && config.clientSecret && config.refreshToken);

/** Runtime-resolved credentials for outbound API calls and CRC replies. */
export interface XEffectiveConfig {
  accessToken: string;
  baseUrl: string;
  consumerSecret: string;
  xUserId: string;
}

/** Credentials required for X Account Activity webhook registration. */
export interface XEnsureWebhookInput {
  accessToken: string;
  accessTokenSecret?: string;
  appBearerToken: string;
  baseUrl?: string;
  // OAuth 1.0a User Context creds for the subscribe call. When all three are
  // present the subscription is OAuth 1.0a-signed; otherwise `accessToken` is
  // sent as an OAuth 2.0 user-context Bearer.
  consumerKey?: string;
  consumerSecret?: string;
  /**
   * Activity event types to subscribe to via `POST /2/activity/subscriptions`
   * (e.g. `dm.received`, `dm.sent`). Defaults to the DM message events.
   */
  eventTypes?: string[];
  /** Connected account id — required as the `filter.user_id` of each subscription. */
  xUserId: string;
}

/** Default X activity event types subscribed for the connected account. */
export const DEFAULT_X_EVENT_TYPES = [
  "dm.received",
  "dm.sent",
  "chat.received",
  "chat.sent",
];
