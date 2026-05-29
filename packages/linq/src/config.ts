import z from "zod";

/**
 * The platform identifier — used for ALL THREE of:
 *
 * - the `defineFusorPlatform` name (so `message.platform` / `__platform` and
 *   the `platformStates` key are this value),
 * - the `fusor(...)` routing key the handler is registered under, and
 * - the value Fusor tags inbound LinQ events with (`event.platform`).
 *
 * Spectrum's webhook delivery looks the runtime up by `event.platform` against
 * the platform name (`platformStates.get(event.platform)`), while routing is by
 * the fusor key — so these MUST be the same string. It must also match Fusor's
 * configured platform identifier for LinQ.
 */
export const LINQ_PLATFORM = "linq";

/** Reject webhooks whose signed timestamp is older than this, by default. */
export const DEFAULT_REPLAY_TOLERANCE_SEC = 300;

export const configSchema = z.object({
  /** LinQ bearer token (outbound API calls + media downloads). */
  apiKey: z.string().min(1),
  /**
   * Per-subscription HMAC secret. When present, inbound webhooks are verified
   * and replay-guarded; when omitted, the signature check is skipped.
   */
  webhookSigningSecret: z.string().min(1).optional(),
  /** Provisioned phone number used to create a chat for a proactive send. */
  defaultFrom: z.string().min(1).optional(),
  /** Override the LinQ API base URL. Defaults to the SDK's built-in base. */
  baseUrl: z.url().optional(),
  /** Reject webhooks whose timestamp is older than this many seconds. */
  replayToleranceSec: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_REPLAY_TOLERANCE_SEC),
});

export type LinqConfig = z.infer<typeof configSchema>;
