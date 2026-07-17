import { createLogger } from "@photon-ai/otel";
import type {
  InboundReply,
  RawInboundEvent,
} from "@photon-ai/proto/photon/fusor/v1/inbound";
import type { ProviderMessageRecord } from "../platform/types";
import { officialProviderInstallHint } from "../utils/provider-packages";
import { errorAttrs } from "../utils/telemetry";
import { createFusorTokenProvider, type FusorTokenProvider } from "./auth";
import {
  type FusorCursorStore,
  MemoryFusorCursorStore,
  normalizeFusorCursor,
} from "./cursor";
import { FUSOR_MESSAGES_CHANNEL, isFusorEvent } from "./event";
import { type ParsedHttpRequest, parseHttpRequest } from "./parse";
import type { FusorMessagesReturn, FusorReply, FusorVerify } from "./types";
import {
  DEFAULT_FUSOR_MAX_PENDING_BYTES,
  DEFAULT_FUSOR_MAX_PENDING_EVENTS,
  DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS,
  FusorWsError,
  type FusorWsSession,
  isWsAuthError,
  runFusorWsSession,
} from "./websocket";

const DEFAULT_FUSOR_WS_URL =
  "wss://fusor-ws.spectrum.photon.codes/v1/subscribe";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 300_000;
const STABLE_SESSION_MS = 60_000;
const EVENT_DEDUPE_CAPACITY = 10_000;

const log = createLogger("spectrum.fusor");
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface RegisteredFusorHandler<TPayload = unknown> {
  messages: (ctx: {
    payload: TPayload;
    respond: (reply: FusorReply) => void;
    signal: AbortSignal;
  }) => FusorMessagesReturn | Promise<FusorMessagesReturn>;
  // Route a `fusorEvent(channel, data)` to its custom event channel. Wired by
  // the Spectrum bootstrap to the per-(platform, channel) queue.
  pushEvent: (channel: string, data: unknown) => void;
  pushMessage: (record: ProviderMessageRecord) => void;
  verify: FusorVerify<TPayload>;
}

function toReplyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) {
    return new Uint8Array(0);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  return body;
}

interface HandlerOutcome {
  errorReason?: string;
  ok: boolean;
  reply?: FusorReply;
}

function combineReplies(outcomes: HandlerOutcome[]): InboundReply {
  const successes = outcomes.filter((o) => o.ok);
  if (successes.length === 0) {
    const firstFailure = outcomes[0];
    return {
      eventId: "",
      errorReason: firstFailure?.errorReason ?? "no handler succeeded",
      status: 0,
      headers: {},
      body: new Uint8Array(0),
    };
  }

  let status = 0;
  const headers: Record<string, string> = {};
  let body: Uint8Array = new Uint8Array(0);

  for (const outcome of successes) {
    const reply = outcome.reply;
    if (!reply) {
      continue;
    }
    if (reply.status !== undefined && reply.status > status) {
      status = reply.status;
    }
    if (reply.headers) {
      for (const [k, v] of Object.entries(reply.headers)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const candidate = toReplyBytes(reply.body);
    if (candidate.length > 0) {
      body = candidate;
    }
  }

  return {
    eventId: "",
    errorReason: "",
    status,
    headers,
    body,
  };
}

// Route a handler's return value. A bare record (or `fusorEvent("messages", …)`)
// goes to the message sink (`deliver`, which the webhook path overrides);
// `fusorEvent(channel, …)` goes to its per-channel queue via `pushEvent` —
// always, on both transports, since the webhook handler is messages-only.
function routeHandlerResult(
  result: FusorMessagesReturn,
  handler: RegisteredFusorHandler,
  deliver: (record: ProviderMessageRecord) => void
): void {
  if (result === undefined) {
    return;
  }
  const items = Array.isArray(result) ? result : [result];
  for (const item of items) {
    if (!isFusorEvent(item)) {
      deliver(item);
      continue;
    }
    if (item.name === FUSOR_MESSAGES_CHANNEL) {
      deliver(item.data as ProviderMessageRecord);
    } else {
      handler.pushEvent(item.name, item.data);
    }
  }
}

function runHandlerOnce<TPayload>(
  handler: RegisteredFusorHandler<TPayload>,
  parsedRequest: ParsedHttpRequest,
  deliver: (record: ProviderMessageRecord) => void = handler.pushMessage,
  signal: AbortSignal = NEVER_ABORTED_SIGNAL
): Promise<HandlerOutcome> {
  return (async () => {
    try {
      const payload = await handler.verify(parsedRequest);
      if (signal.aborted) {
        return { ok: false, errorReason: "event processing aborted" };
      }
      let reply: FusorReply | undefined;
      let respondCalled = false;
      let returned = false;
      const respond = (next: FusorReply): void => {
        if (returned) {
          log.warn("fusor.respond called after handler returned; ignoring");
          return;
        }
        if (respondCalled) {
          log.debug("fusor.respond called more than once; last call wins");
        }
        respondCalled = true;
        reply = next;
      };
      const result = await handler.messages({ payload, respond, signal });
      returned = true;

      if (signal.aborted) {
        return { ok: false, errorReason: "event processing aborted" };
      }
      routeHandlerResult(result, handler as RegisteredFusorHandler, deliver);
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, errorReason: errorText(error) };
    }
  })();
}

export interface FusorCoreOptions {
  /** Cursor persistence used by the streaming transport. */
  cursorStore?: FusorCursorStore;
  /** Maximum UTF-8 wire bytes held by admitted WebSocket event frames. */
  maxPendingBytes?: number;
  /** Maximum admitted WebSocket events, including the in-flight event. */
  maxPendingEvents?: number;
  // Optional: only the streaming transport (start) needs cloud credentials to
  // mint a token. The webhook path (processEvent) routes registered handlers
  // without them, so a webhook-only Spectrum can construct a core with
  // neither set.
  projectId?: string;
  projectSecret?: string;
  /** Maximum time shutdown waits for an uncooperative event handler. */
  shutdownTimeoutMs?: number;
  /**
   * fusor-fanout-websocket endpoint (`wss://…/v1/subscribe`) — the
   * streaming transport. Defaults to the `SPECTRUM_FUSOR_WS_URL` env
   * var, then the production endpoint.
   */
  websocketEndpoint?: string;
}

export class FusorCore {
  private readonly options: FusorCoreOptions;
  private readonly websocketEndpoint: string;
  private readonly cursorStore: FusorCursorStore;
  private readonly maxPendingEvents: number;
  private readonly maxPendingBytes: number;
  private readonly shutdownTimeoutMs: number;
  private readonly processedEventIds = new Map<string, undefined>();
  private readonly handlers = new Map<string, RegisteredFusorHandler[]>();
  private tokenProvider?: FusorTokenProvider;
  private wsSession?: FusorWsSession;
  private connectionLoop?: Promise<void>;
  private started = false;
  private stopped = false;
  private stopResolve?: () => void;
  private readonly stoppedPromise: Promise<void>;
  // The reconnect backoff sleep, made cancelable so close() can wake it.
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectResolve?: () => void;

  constructor(options: FusorCoreOptions) {
    this.options = options;
    this.websocketEndpoint =
      options.websocketEndpoint ??
      process.env.SPECTRUM_FUSOR_WS_URL ??
      DEFAULT_FUSOR_WS_URL;
    this.cursorStore = options.cursorStore ?? new MemoryFusorCursorStore();
    this.maxPendingEvents =
      options.maxPendingEvents ?? DEFAULT_FUSOR_MAX_PENDING_EVENTS;
    this.maxPendingBytes =
      options.maxPendingBytes ?? DEFAULT_FUSOR_MAX_PENDING_BYTES;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  register<TPayload>(
    platform: string,
    handler: RegisteredFusorHandler<TPayload>
  ): void {
    const list = this.handlers.get(platform) ?? [];
    list.push(handler as RegisteredFusorHandler);
    this.handlers.set(platform, list);
  }

  async start(): Promise<void> {
    if (!(this.options.projectId && this.options.projectSecret)) {
      throw new Error(
        "fusor: streaming via spectrum.messages requires projectId and projectSecret"
      );
    }
    // Idempotent: a second start() must not spin up a duplicate token provider,
    // channel, or connection loop. The flag is set synchronously before the
    // first await so concurrent calls are guarded too.
    if (this.started) {
      return;
    }
    this.started = true;
    this.connectionLoop = this.runConnectionLoop().catch((error) => {
      log.error("fusor connection loop crashed", errorAttrs(error), error);
    });
  }

  // Streaming transport: every reconnect uses equal-jitter exponential
  // backoff. The failure counter resets only after a minute of stable ready
  // time, so accept-then-close loops cannot pin retries at one second.
  private async runConnectionLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const outcome = await this.tryWebsocketOnce();
      if (this.stopped) {
        return;
      }
      if (outcome.stable) {
        attempt = 0;
      }
      attempt += 1;
      const retryAfterMs = Math.min(
        outcome.retryAfterMs ?? 0,
        RETRY_AFTER_MAX_MS
      );
      await this.backoffSleep(Math.max(this.backoffMs(attempt), retryAfterMs));
    }
  }

  private async tryWebsocketOnce(): Promise<{
    retryAfterMs?: number;
    stable: boolean;
  }> {
    let readyAt: number | undefined;
    try {
      await this.runWebsocketOnce(() => {
        readyAt ??= Date.now();
      });
      return {
        stable:
          readyAt !== undefined && Date.now() - readyAt >= STABLE_SESSION_MS,
      };
    } catch (error) {
      // Drop a stale token on auth failure so the next attempt mints a
      // fresh one instead of replaying the rejected token.
      if (isWsAuthError(error)) {
        this.tokenProvider?.invalidate();
      }
      if (!this.stopped) {
        log.warn(
          "fusor websocket stream errored; reconnecting",
          errorAttrs(error),
          error
        );
      }
      return {
        stable:
          readyAt !== undefined && Date.now() - readyAt >= STABLE_SESSION_MS,
        retryAfterMs:
          error instanceof FusorWsError ? error.retryAfterMs : undefined,
      };
    }
  }

  private backoffMs(attempt: number): number {
    const cap = Math.min(
      RECONNECT_BASE_MS * 2 ** (attempt - 1),
      RECONNECT_MAX_MS
    );
    return Math.round(cap / 2 + Math.random() * (cap / 2));
  }

  // Cancelable sleep: close() clears the timer and resolves it so
  // shutdown doesn't wait out the (up to 30s) backoff. Keep the timer
  // referenced: a stream-only Node worker may have no other active handle,
  // and must stay alive long enough to reconnect.
  private async backoffSleep(backoff: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.reconnectResolve = resolve;
      const timer = setTimeout(resolve, backoff);
      this.reconnectTimer = timer;
    });
    this.reconnectTimer = undefined;
    this.reconnectResolve = undefined;
  }

  private async runWebsocketOnce(onReady: () => void): Promise<void> {
    const projectId = this.options.projectId;
    const projectSecret = this.options.projectSecret;
    if (!(projectId && projectSecret)) {
      throw new Error("fusor: project credentials not initialized");
    }
    if (!this.tokenProvider) {
      const tokenProvider = await createFusorTokenProvider(
        projectId,
        projectSecret
      );
      if (this.stopped) {
        await tokenProvider.dispose();
        return;
      }
      this.tokenProvider = tokenProvider;
    }
    const token = await this.tokenProvider.getToken();
    if (this.stopped) {
      return;
    }
    const startSeq = normalizeFusorCursor(
      await this.cursorStore.load(projectId)
    );
    if (this.stopped) {
      return;
    }
    const session = runFusorWsSession({
      url: this.websocketEndpoint,
      token,
      startSeq,
      maxPendingBytes: this.maxPendingBytes,
      maxPendingEvents: this.maxPendingEvents,
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      onReady,
      onEvent: async (event, seq, sendReply, signal) => {
        if (this.stopped || signal.aborted) {
          return;
        }
        if (this.processedEventIds.has(event.eventId)) {
          if (signal.aborted) {
            return;
          }
          await this.cursorStore.save(projectId, seq);
          return;
        }
        const reply = await this.processEvent(event, undefined, signal);
        if (this.stopped || signal.aborted) {
          return;
        }
        // The server answers unexpected replies with typed notices —
        // only reply when asked (sendReply is set iff replyExpected).
        sendReply?.(reply);
        // Remember successful processing before the durable checkpoint. If
        // the store fails, the reconnect deliberately asks for this event
        // again; the process-local id cache then retries the checkpoint
        // without duplicating provider delivery.
        this.rememberProcessedEvent(event.eventId);
        await this.cursorStore.save(projectId, seq);
      },
    });
    this.wsSession = session;
    try {
      await session.done;
    } finally {
      this.wsSession = undefined;
    }
  }

  private rememberProcessedEvent(eventId: string): void {
    this.processedEventIds.delete(eventId);
    this.processedEventIds.set(eventId, undefined);
    if (this.processedEventIds.size <= EVENT_DEDUPE_CAPACITY) {
      return;
    }
    const oldest = this.processedEventIds.keys().next().value;
    if (oldest !== undefined) {
      this.processedEventIds.delete(oldest);
    }
  }

  // Transport-independent event processing: route by platform, parse the wire
  // request, run every registered handler (verify → messages), and combine the
  // results into a single InboundReply. Returns the reply instead of writing it
  // anywhere, so both the streaming session (sendReply) and the synchronous
  // webhook path can drive it. `deliver` controls where produced records go:
  // the streaming path defaults to each handler's pushMessage (the per-platform
  // queue feeding spectrum.messages); the webhook path collects them for the
  // request instead.
  async processEvent(
    event: RawInboundEvent,
    deliver?: (record: ProviderMessageRecord) => void,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL
  ): Promise<InboundReply> {
    const handlers = this.handlers.get(event.platform) ?? [];
    if (handlers.length === 0) {
      // Reply shape stays wire-compatible; only the local log gets the
      // install hint (since v5 the official providers are separate packages,
      // so "no handler" is usually a missing install, not a routing bug).
      const hint = officialProviderInstallHint(event.platform);
      log.warn(
        hint
          ? `fusor: no handler for platform — ${hint}`
          : "fusor: no handler for platform",
        {
          "spectrum.fusor.platform": event.platform,
          "spectrum.fusor.event_id": event.eventId,
        }
      );
      return {
        eventId: event.eventId,
        errorReason: `no handler for platform ${event.platform}`,
        status: 0,
        headers: {},
        body: new Uint8Array(0),
      };
    }

    let parsedRequest: ParsedHttpRequest;
    try {
      parsedRequest = parseHttpRequest(event.rawRequest);
    } catch (error) {
      const errorReason = errorText(error);
      log.warn("fusor: failed to parse raw_request", {
        "spectrum.fusor.platform": event.platform,
        "spectrum.fusor.event_id": event.eventId,
        ...errorAttrs(error),
      });
      return {
        eventId: event.eventId,
        errorReason,
        status: 0,
        headers: {},
        body: new Uint8Array(0),
      };
    }

    const outcomes = await Promise.all(
      handlers.map((handler) =>
        runHandlerOnce(handler, parsedRequest, deliver, signal)
      )
    );

    const combined = combineReplies(outcomes);
    combined.eventId = event.eventId;
    return combined;
  }

  async close(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.wsSession?.close();
    // Wake an in-progress reconnect backoff so the loop observes stopped and
    // exits immediately instead of waiting out the timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectResolve?.();
    this.reconnectResolve = undefined;
    if (this.tokenProvider) {
      await this.tokenProvider.dispose();
    }
    if (this.connectionLoop) {
      await this.connectionLoop;
    }
    this.stopResolve?.();
  }

  async waitStopped(): Promise<void> {
    return this.stoppedPromise;
  }
}
