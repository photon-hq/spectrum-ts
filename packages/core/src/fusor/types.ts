import type { ProviderMessageRecord } from "../platform/types";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import type { ProjectData } from "../utils/cloud";
import type { Store } from "../utils/store";
import type { FusorEvent } from "./event";

export interface FusorVerifyRequest {
  headers: Record<string, string>;
  method: string;
  path: string;
  rawBody: Uint8Array;
}

/**
 * Verify and decode one provider request. Thrown errors reject that event as
 * terminal unless wrapped in FusorRetryableError.
 */
export type FusorVerify<TPayload = unknown> = (
  req: FusorVerifyRequest
) => TPayload | Promise<TPayload>;

export interface FusorReply {
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  status?: number;
}

/**
 * Mark a provider verification or message-processing failure as safe to retry.
 * Streaming delivery reconnects from the prior durable checkpoint.
 */
export class FusorRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FusorRetryableError";
  }
}

/**
 * Mark a provider message-processing failure as deterministic for this event.
 * Streaming delivery returns an error reply and advances its checkpoint.
 */
export class FusorTerminalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FusorTerminalError";
  }
}

export type FusorRespond = (reply: FusorReply) => void;

export interface FusorMessagesCtx<TPayload, TConfig = unknown> {
  /** Parsed provider config (`z.infer` of the platform's config schema). */
  config: TConfig;
  payload: TPayload;
  /**
   * Spectrum Cloud project metadata, fetched once at `Spectrum()` init.
   * `undefined` for local-only setups (no `projectId`/`projectSecret`). Read
   * project-level toggles from `projectConfig.profile.<key>`.
   */
  projectConfig: ProjectData | undefined;
  respond: FusorRespond;
  /** Per-platform in-memory key/value store, shared with the rest of the platform. */
  store: Store;
}

export type FusorMessagesReturn =
  | ProviderMessageRecord
  | FusorEvent
  | (ProviderMessageRecord | FusorEvent)[]
  | undefined;

/**
 * Process one verified payload. Thrown errors retry streaming delivery unless
 * wrapped in FusorTerminalError. Providers should keep side effects idempotent.
 */
export type FusorMessages<TPayload, TConfig = unknown> = (
  ctx: FusorMessagesCtx<TPayload, TConfig>
) => FusorMessagesReturn | Promise<FusorMessagesReturn>;

/**
 * Initialization context for a hybrid provider's optional Fusor transport.
 *
 * Hybrid providers retain their regular, long-lived SDK client for actions,
 * outbound sends, regular event producers, and teardown. The Fusor binding is
 * an additional inbound source only, so its initializer receives that client
 * alongside the normal provider initialization context and may return
 * `undefined` to keep using only the provider's regular message source.
 */
export interface HybridFusorCreateContext<TClient, TConfig = unknown> {
  client: TClient;
  config: TConfig;
  projectConfig: ProjectData | undefined;
  projectId: string | undefined;
  projectSecret: string | undefined;
  store: Store;
}

/** Runtime context for a hybrid provider's per-payload Fusor handler. */
export interface HybridFusorMessagesCtx<TPayload, TClient, TConfig = unknown>
  extends FusorMessagesCtx<TPayload, TConfig> {
  /** The provider's regular lifecycle client, not the Fusor routing client. */
  client: TClient;
}

/**
 * Hybrid handlers emit only core message records. Custom event channels remain
 * regular `events` producers backed by the provider's regular client.
 */
export type HybridFusorMessagesReturn =
  | ProviderMessageRecord
  | ProviderMessageRecord[]
  | undefined;

export type HybridFusorMessages<TPayload, TClient, TConfig = unknown> = (
  ctx: HybridFusorMessagesCtx<TPayload, TClient, TConfig>
) => HybridFusorMessagesReturn | Promise<HybridFusorMessagesReturn>;

/**
 * Optional Fusor inbound binding for a provider that also owns a regular SDK
 * client. `create` is evaluated once during `Spectrum()` initialization;
 * returning `undefined` leaves the provider entirely on its regular transport.
 */
export interface HybridFusor<TPayload, TClient, TConfig = unknown> {
  create: (
    ctx: HybridFusorCreateContext<TClient, TConfig>
  ) =>
    | FusorClient<TPayload>
    | undefined
    | Promise<FusorClient<TPayload> | undefined>;
  messages: HybridFusorMessages<TPayload, TClient, TConfig>;
  /**
   * Restrict this binding to events received over Fusor's authenticated
   * streaming transport. When enabled, a caller cannot invoke the binding by
   * posting a raw Fusor protobuf envelope to `spectrum.webhook()`.
   *
   * @default false
   */
  streamOnly?: boolean;
}

export const FUSOR_BRAND: unique symbol = Symbol.for("spectrum.fusor.client");

export interface FusorClient<TPayload = unknown> {
  readonly platform: string;
  readonly verify: FusorVerify<TPayload>;
  readonly [FUSOR_BRAND]: true;
}

// ---------------------------------------------------------------------------
// Webhook transport (spectrum.webhook)
// ---------------------------------------------------------------------------

/**
 * Request-scoped handler invoked once per inbound message that
 * `spectrum.webhook()` resolves. Receives the same fully-built `[space,
 * message]` pair that `spectrum.messages` yields.
 *
 * Runs **fire-and-forget**: it is dispatched after the HTTP response (the
 * platform's `respond()` reply) has already been computed, so its outcome never
 * affects the response, and a throw is caught + logged rather than surfaced —
 * mirroring the body of a `for await (… of spectrum.messages)` loop.
 *
 * On a long-running server the event loop keeps the handler alive. On
 * serverless/edge runtimes the function may be frozen once the response is
 * returned, so keeping background work alive is the caller's responsibility —
 * the usual pattern is to enqueue the work and process it in a separate worker.
 */
export type WebhookHandler = (
  space: Space,
  message: Message
) => void | Promise<void>;

/**
 * Raw webhook input for HTTP servers without Web `Request`/`Response` (Express,
 * raw Node). `body` MUST be the exact bytes POSTed — never a re-encoded
 * JSON/text body — so both the protobuf decode (fusor) and the HMAC
 * verification (native Spectrum webhook) work.
 *
 * `headers` ARE read for **native Spectrum webhooks**: `X-Spectrum-Signature` /
 * `X-Spectrum-Timestamp` carry the HMAC verified against
 * `Spectrum({ webhookSecret })`, and the signature header also selects the
 * native path. For **fusor** envelopes they are ignored (authenticity is the
 * per-platform `verify()` reading the inner reconstructed request). The natural
 * `{ headers: req.headers, body: req.body }` shape works for both.
 */
export interface WebhookRawRequest {
  body: Uint8Array | ArrayBuffer;
  headers?: Record<string, string>;
}

/** Raw webhook result, written back by the caller as the HTTP response. */
export interface WebhookRawResult {
  body: Uint8Array;
  headers: Record<string, string>;
  status: number;
}
