import z from "zod";

/**
 * Platform identifier used by `definePlatform`, fusor routing, and the
 * super-webhook path segment.
 */
export const X_PLATFORM = "x";

/** Default X API origin. */
export const DEFAULT_BASE_URL = "https://api.x.com";

const xUserIdField = z.string().regex(/^\d+$/, "xUserId must be numeric");

/** Cloud mode: OAuth + credentials from Spectrum Cloud. */
export const cloudConfigSchema = z
  .object({
    /** Pin one bot when multiple x_accounts are linked to the project. */
    xUserId: xUserIdField.optional(),
    /** App-only bearer for webhook list/create when registering at startup. */
    appBearerToken: z.string().min(1).optional(),
    /** Override Fusor edge URL base (e.g. local ngrok) instead of {slug}.spctrm.dev. */
    webhookBaseUrl: z.string().url().optional(),
    /**
     * Optional override for CRC HMAC + webhook signature verification.
     * Defaults to the app consumer secret from Spectrum Cloud credentials.
     */
    consumerSecret: z.string().min(1).optional(),
  })
  .strict();

/** Direct mode: static credentials (local dev / self-host). */
export const directConfigSchema = z.object({
  /** App consumer secret used for webhook CRC + signature verification. */
  consumerSecret: z.string().min(1),
  /** User-context OAuth token used for outbound DMs + subscription call. */
  accessToken: z.string().min(1),
  /** Connected account id (numeric) used for echo filtering and routing. */
  xUserId: xUserIdField,
  /** App-only bearer used for webhook registration/list operations. */
  appBearerToken: z.string().min(1),
  /** Override the X API base URL for tests/local stubs. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
});

export const configSchema = z.union([directConfigSchema, cloudConfigSchema]);

export type XCloudConfig = z.infer<typeof cloudConfigSchema>;
export type XDirectConfig = z.infer<typeof directConfigSchema>;
export type XConfig = XCloudConfig | XDirectConfig;

export const isCloudConfig = (config: XConfig): config is XCloudConfig =>
  !("accessToken" in config);

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
  appBearerToken: string;
  baseUrl?: string;
}
