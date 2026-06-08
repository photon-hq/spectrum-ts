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

export type FusorVerify<TPayload = unknown> = (
  req: FusorVerifyRequest
) => TPayload | Promise<TPayload>;

export interface FusorReply {
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  status?: number;
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

export type FusorMessages<TPayload, TConfig = unknown> = (
  ctx: FusorMessagesCtx<TPayload, TConfig>
) => FusorMessagesReturn | Promise<FusorMessagesReturn>;

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
 * raw Node). `body` MUST be the exact bytes fusor POSTed — never a re-encoded
 * JSON/text body — so the protobuf decode works. `headers` are accepted (so the
 * natural `{ headers: req.headers, body: req.body }` shape keeps working) but are
 * not read: inbound authenticity is established by the per-platform `verify()`,
 * which reads the inner request reconstructed from the envelope.
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
