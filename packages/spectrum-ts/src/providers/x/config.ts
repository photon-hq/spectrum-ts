import z from "zod";

/**
 * Platform identifier used by `definePlatform`, fusor routing, and the
 * super-webhook path segment.
 */
export const X_PLATFORM = "x";

/** Default X API origin. */
export const DEFAULT_BASE_URL = "https://api.x.com";

export const configSchema = z.object({
  /** App consumer secret used for webhook CRC + signature verification. */
  consumerSecret: z.string().min(1),
  /** User-context OAuth token used for outbound DMs + subscription call. */
  accessToken: z.string().min(1),
  /** Connected account id (numeric) used for echo filtering and routing. */
  xUserId: z.string().regex(/^\d+$/, "xUserId must be numeric"),
  /** App-only bearer used for webhook registration/list operations. */
  appBearerToken: z.string().min(1),
  /** Override the X API base URL for tests/local stubs. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
});

export type XConfig = z.infer<typeof configSchema>;
