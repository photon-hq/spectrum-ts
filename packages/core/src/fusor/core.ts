import { createLogger } from "@photon-ai/otel";
import type {
  InboundReply,
  RawInboundEvent,
} from "@photon-ai/proto/photon/fusor/v1/inbound";
import type { ProviderMessageRecord } from "../platform/types";
import { SpectrumCloudError } from "../utils/cloud";
import { officialProviderInstallHint } from "../utils/provider-packages";
import { errorAttrs } from "../utils/telemetry";
import { createFusorTokenProvider, type FusorTokenProvider } from "./auth";
import { FUSOR_MESSAGES_CHANNEL, isFusorEvent } from "./event";
import { type ParsedHttpRequest, parseHttpRequest } from "./parse";
import {
  type FusorMessagesReturn,
  type FusorReply,
  FusorRetryableError,
  FusorTerminalError,
  type FusorVerify,
} from "./types";
import {
  DEFAULT_FUSOR_MAX_PENDING_BYTES,
  DEFAULT_FUSOR_MAX_PENDING_EVENTS,
  DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS,
  FusorWsError,
  type FusorWsSession,
  isWsAuthError,
  isWsTerminalError,
  runFusorWsSession,
} from "./websocket";

const DEFAULT_FUSOR_WS_URL =
  "wss://fusor-ws.spectrum.photon.codes/v1/subscribe";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_STABLE_MS = 30_000;
const RETRY_AFTER_MAX_MS = 300_000;
const RETRYABLE_CLOUD_CLIENT_STATUSES = new Set([408, 425, 429]);
// Event ids protect against transport redelivery at a new sequence (or an
// overlapping reconnect). The safe sequence handles normal retained replay;
// keep the id cache bounded so a long-lived SDK process cannot grow forever.
const PROCESSED_EVENT_ID_CACHE_SIZE = 4096;

const log = createLogger("spectrum.fusor");
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isValidCursor = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) < Number.MAX_SAFE_INTEGER;

const isPermanentTokenMintError = (error: unknown): boolean =>
  error instanceof SpectrumCloudError &&
  error.status >= 400 &&
  error.status < 500 &&
  !RETRYABLE_CLOUD_CLIENT_STATUSES.has(error.status);

export interface FusorCursorScope {
  readonly projectId: string;
  readonly websocketEndpoint: string;
}

/**
 * Optional persistence for the Fusor transport's normalization/enqueue cursor.
 *
 * A scope represents one logical stream consumer. Store implementations used
 * by multiple processes must make saves monotonic (for example, max/CAS) so a
 * lagging writer cannot regress a newer checkpoint. A successful save means
 * provider verification/normalization and synchronous enqueue completed; it
 * does not mean an application consumed an in-memory `spectrum.messages`
 * record. A crash between save and consumption can therefore lose that queued
 * record. Use a durable application sink for end-to-end delivery guarantees.
 */
export interface FusorCursorStore {
  load(scope: FusorCursorScope): Promise<number | undefined>;
  save(scope: FusorCursorScope, seq: number): Promise<void>;
}

export type FusorEventProvenance = "stream" | "webhook";

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
  /** Exclude this handler from the synchronous webhook transport. */
  streamOnly?: boolean;
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
  error?: unknown;
  errorReason?: string;
  ok: boolean;
  reply?: FusorReply;
  retryable?: boolean;
}

interface ProcessEventOutcome {
  reply: InboundReply;
  retryableError?: Error;
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
    let payload: TPayload;
    try {
      payload = await handler.verify(parsedRequest);
    } catch (error) {
      // Verification failures are normally deterministic input/auth failures.
      // Providers whose verifier depends on a fallible remote service can opt
      // into retained replay with FusorRetryableError.
      return {
        error,
        errorReason: errorText(error),
        ok: false,
        retryable: error instanceof FusorRetryableError,
      };
    }
    if (signal.aborted) {
      return {
        errorReason: "event processing aborted",
        ok: false,
        retryable: true,
      };
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
    try {
      const result = await handler.messages({ payload, respond, signal });
      returned = true;

      if (signal.aborted) {
        return {
          errorReason: "event processing aborted",
          ok: false,
          retryable: true,
        };
      }
      routeHandlerResult(result, handler as RegisteredFusorHandler, deliver);
      return { ok: true, reply };
    } catch (error) {
      // Message processing can perform I/O, so an unclassified exception is
      // retryable by default. Providers must explicitly mark deterministic
      // per-event rejection to prevent a poison event from blocking the stream.
      return {
        error,
        errorReason: errorText(error),
        ok: false,
        retryable: !(error instanceof FusorTerminalError),
      };
    } finally {
      // A handler that rejects has returned too; reject any later respond().
      returned = true;
    }
  })();
}

export interface FusorCoreOptions {
  /**
   * Transport cursor hooks. Scope is always the resolved endpoint plus project;
   * `save` must resolve before the in-memory checkpoint advances. This is an
   * SDK normalization/enqueue checkpoint, not an application-consumption ack.
   * Without a store, startSeq=0 subscribes at the live tail and cannot recover
   * a bootstrap or process-restart gap.
   */
  cursorStore?: FusorCursorStore;
  /** Maximum UTF-8 wire bytes held by admitted WebSocket event frames. */
  maxPendingBytes?: number;
  /** Maximum admitted WebSocket events, including the in-flight event. */
  maxPendingEvents?: number;
  /** Internal lifecycle hook used to surface post-ready terminal failures. */
  onTerminal?: (error: Error) => void;
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
  private readonly handlers = new Map<string, RegisteredFusorHandler[]>();
  private readonly processedEventIds = new Map<string, number>();
  // Global JetStream cursor of the last event whose provider normalization and
  // synchronous enqueue/reply completed and whose optional external save
  // succeeded. This is not an application-consumption acknowledgement. Without
  // cursorStore it is process-local: startSeq=0 is a live tail and cannot
  // recover bootstrap or process-restart gaps.
  private lastProcessedSeq = 0;
  private tokenProvider?: FusorTokenProvider;
  private wsSession?: FusorWsSession;
  private connectionLoop?: Promise<void>;
  private connectionLoopError?: unknown;
  private firstReadyReject?: (error: Error) => void;
  private firstReadyResolve?: () => void;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
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

  start(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error("fusor: cannot start after close"));
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (!(this.options.projectId && this.options.projectSecret)) {
      return Promise.reject(
        new Error(
          "fusor: streaming via spectrum.messages requires projectId and projectSecret"
        )
      );
    }

    this.startPromise = this.startOnce(this.options.projectId);
    return this.startPromise;
  }

  private async startOnce(projectId: string): Promise<void> {
    const scope = this.cursorScope(projectId);
    if (this.options.cursorStore) {
      const loaded = await this.options.cursorStore.load(scope);
      if (loaded !== undefined && !isValidCursor(loaded)) {
        throw new Error(
          "fusor: cursor store returned an invalid cursor; expected a non-negative safe integer below Number.MAX_SAFE_INTEGER"
        );
      }
      if (this.stopped) {
        return;
      }
      this.lastProcessedSeq = loaded ?? 0;
    }

    const firstReady = new Promise<void>((resolve, reject) => {
      this.firstReadyResolve = resolve;
      this.firstReadyReject = reject;
    });
    this.connectionLoop = this.runConnectionLoop().then(
      () => {
        // Preserve cancellation semantics from the pre-loop initial mint:
        // stopping before a token provider ever became usable is a clean
        // startup cancellation. Once a provider existed, stopping before the
        // first ready frame remains an observable failed startup.
        if (this.stopped && !this.tokenProvider) {
          this.resolveFirstReady();
        } else {
          this.rejectFirstReady(
            new Error("fusor: stopped before websocket stream became ready")
          );
        }
      },
      async (error: unknown) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        this.rejectFirstReady(normalizedError);
        log.error("fusor connection loop crashed", errorAttrs(error), error);
        if (this.stopped) {
          // close() initiated this stop. Preserve handler/checkpoint/physical
          // close failures so the shared shutdown promise cannot report success.
          this.connectionLoopError ??= error;
          return;
        }
        // A terminal transport invariant cannot be repaired by reconnecting.
        // Publish the lifecycle transition so post-ready waitStopped() callers
        // do not wait forever after start() has already returned.
        this.stopped = true;
        try {
          this.options.onTerminal?.(normalizedError);
        } catch (callbackError) {
          log.error(
            "fusor terminal callback failed",
            errorAttrs(callbackError),
            callbackError
          );
        }
        const provider = this.tokenProvider;
        this.tokenProvider = undefined;
        try {
          await provider?.dispose();
        } catch (disposeError) {
          log.error(
            "fusor token provider disposal failed",
            errorAttrs(disposeError),
            disposeError
          );
        } finally {
          this.stopResolve?.();
          this.stopResolve = undefined;
        }
      }
    );
    await firstReady;
  }

  private resolveFirstReady(): void {
    const resolve = this.firstReadyResolve;
    this.firstReadyResolve = undefined;
    this.firstReadyReject = undefined;
    resolve?.();
  }

  private rejectFirstReady(error: Error): void {
    const reject = this.firstReadyReject;
    this.firstReadyResolve = undefined;
    this.firstReadyReject = undefined;
    reject?.(error);
  }

  private cursorScope(projectId: string): FusorCursorScope {
    return {
      projectId,
      websocketEndpoint: this.websocketEndpoint,
    };
  }

  // Streaming transport: the fusor.v1.json WebSocket plane. Retry backoff uses
  // full jitter, honors bounded server delay hints, and resets after a
  // connection stayed ready long enough to be considered stable, not only
  // after a clean close (which remote sockets do not normally provide).
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

  // True when the session remained ready for the stability window. Terminal
  // protocol/auth invariants escape this method and stop the loop; rejected
  // credentials instead invalidate the cached token and retry.
  private async tryWebsocketOnce(): Promise<{
    retryAfterMs?: number;
    stable: boolean;
  }> {
    let readyAt: number | undefined;
    let transportClosedAt: number | undefined;
    try {
      await this.runWebsocketOnce(
        () => {
          readyAt ??= Date.now();
          this.resolveFirstReady();
        },
        () => {
          transportClosedAt ??= Date.now();
        }
      );
    } catch (error) {
      if (this.stopped) {
        throw error;
      }
      if (isWsTerminalError(error) || isPermanentTokenMintError(error)) {
        throw error;
      }
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
          readyAt !== undefined &&
          transportClosedAt !== undefined &&
          transportClosedAt - readyAt >= RECONNECT_STABLE_MS,
        retryAfterMs:
          error instanceof FusorWsError ? error.retryAfterMs : undefined,
      };
    }
    return {
      stable:
        readyAt !== undefined &&
        transportClosedAt !== undefined &&
        transportClosedAt - readyAt >= RECONNECT_STABLE_MS,
    };
  }

  private backoffMs(attempt: number): number {
    const ceiling = Math.min(
      RECONNECT_BASE_MS * 2 ** (attempt - 1),
      RECONNECT_MAX_MS
    );
    return Math.floor(Math.random() * (ceiling + 1));
  }

  // Cancelable sleep: close() clears the timer and resolves it so shutdown
  // does not wait out the backoff. Keep the timer referenced: a stream-only
  // Node worker may have no other handle keeping it alive until reconnect.
  private async backoffSleep(backoff: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.reconnectResolve = resolve;
      const timer = setTimeout(resolve, backoff);
      this.reconnectTimer = timer;
    });
    this.reconnectTimer = undefined;
    this.reconnectResolve = undefined;
  }

  private async runWebsocketOnce(
    onReady: () => void,
    onTransportClose: () => void
  ): Promise<void> {
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
    // close() may have run while an expired token was being refreshed. Do not
    // create an untracked replacement socket after shutdown has begun.
    if (this.stopped) {
      return;
    }
    const session = runFusorWsSession({
      url: this.websocketEndpoint,
      token,
      startSeq: this.lastProcessedSeq,
      maxPendingBytes:
        this.options.maxPendingBytes ?? DEFAULT_FUSOR_MAX_PENDING_BYTES,
      maxPendingEvents:
        this.options.maxPendingEvents ?? DEFAULT_FUSOR_MAX_PENDING_EVENTS,
      onReady,
      onTransportClose,
      shutdownTimeoutMs:
        this.options.shutdownTimeoutMs ?? DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS,
      onEvent: async (event, sendReply, seq, signal) => {
        if (this.stopped || signal.aborted) {
          return;
        }
        if (event.projectId !== this.options.projectId) {
          throw new FusorWsError(
            `fusor websocket delivered project ${event.projectId || "<empty>"} to ${this.options.projectId}`,
            undefined,
            "project_mismatch",
            undefined,
            false
          );
        }

        const duplicateReason = this.processedReason(event.eventId, seq);
        if (duplicateReason) {
          // A duplicate event id at a later stream position is itself safe to
          // cross: the original completed already, and ordered delivery means
          // advancing to this duplicate cannot jump over unfinished work.
          if (seq > this.lastProcessedSeq) {
            await this.checkpointProcessed(event.eventId, seq);
          }
          log.debug("fusor websocket duplicate suppressed", {
            "spectrum.fusor.event_id": event.eventId,
            "spectrum.fusor.seq": seq,
            "spectrum.fusor.duplicate_reason": duplicateReason,
          });
          return;
        }

        const outcome = await this.processEventWithOutcome(
          event,
          undefined,
          "stream",
          signal
        );
        // `processEventWithOutcome` checks cancellation before synchronously
        // routing any returned records. Once it resolves without a retryable
        // outcome, enqueue is complete and this event owns its checkpoint even
        // if shutdown raced this continuation. Skipping it here would replay an
        // already-enqueued record after restart.
        if (outcome.retryableError) {
          throw outcome.retryableError;
        }
        // The server answers unexpected replies with typed notices —
        // only reply when asked (sendReply is set iff replyExpected).
        sendReply?.(outcome.reply);
        // This callback is serialized by runFusorWsSession. Checkpoint only
        // after normalization/handler work (including a terminal error reply)
        // and any reply send completed. Retrying every verifier/application
        // error would poison this project-wide stream forever; only transport
        // or durable-checkpoint failures reject the ordered callback.
        await this.checkpointProcessed(event.eventId, seq);
      },
    });
    this.wsSession = session;
    try {
      await session.done;
    } finally {
      this.wsSession = undefined;
    }
  }

  private processedReason(
    eventId: string,
    seq: number
  ): "event_id" | "sequence" | undefined {
    if (seq <= this.lastProcessedSeq) {
      return "sequence";
    }
    if (eventId && this.processedEventIds.has(eventId)) {
      return "event_id";
    }
    return;
  }

  private async checkpointProcessed(
    eventId: string,
    seq: number
  ): Promise<void> {
    try {
      await this.rememberProcessed(eventId, seq);
    } catch (error) {
      // Shutdown suppresses ordinary handler failures after abort, but a
      // failed durable save must still reject close() so the caller never
      // mistakes an unflushed cursor (including a duplicate-id advance) for a
      // clean stop.
      throw new FusorWsError(
        `fusor durable checkpoint failed: ${errorText(error)}`,
        undefined,
        "checkpoint_failed",
        undefined,
        true
      );
    }
  }

  private async rememberProcessed(eventId: string, seq: number): Promise<void> {
    const cursorStore = this.options.cursorStore;
    const projectId = this.options.projectId;
    if (cursorStore) {
      if (!projectId) {
        throw new Error("fusor: cursor store requires projectId");
      }
      // The external checkpoint is the durable boundary. If it rejects, leave
      // the process-local cursor untouched so a positive prior cursor replays
      // this event on reconnect.
      await cursorStore.save(this.cursorScope(projectId), seq);
    }

    // A session whose shutdown deadline elapsed can finish an older durable
    // save after its replacement has already advanced farther. Never let that
    // detached completion regress the reconnect cursor.
    this.lastProcessedSeq = Math.max(this.lastProcessedSeq, seq);
    if (!eventId) {
      return;
    }

    // Map insertion order gives a tiny LRU: refresh a repeated id before
    // evicting the oldest completed transport identity.
    this.processedEventIds.delete(eventId);
    this.processedEventIds.set(eventId, seq);
    if (this.processedEventIds.size <= PROCESSED_EVENT_ID_CACHE_SIZE) {
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
    provenance: FusorEventProvenance = "stream",
    signal: AbortSignal = NEVER_ABORTED_SIGNAL
  ): Promise<InboundReply> {
    return (
      await this.processEventWithOutcome(event, deliver, provenance, signal)
    ).reply;
  }

  private async processEventWithOutcome(
    event: RawInboundEvent,
    deliver?: (record: ProviderMessageRecord) => void,
    provenance: FusorEventProvenance = "stream",
    signal: AbortSignal = NEVER_ABORTED_SIGNAL
  ): Promise<ProcessEventOutcome> {
    const registeredHandlers = this.handlers.get(event.platform) ?? [];
    const handlers =
      provenance === "webhook"
        ? registeredHandlers.filter((handler) => !handler.streamOnly)
        : registeredHandlers;
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
          "spectrum.fusor.provenance": provenance,
        }
      );
      return {
        reply: {
          eventId: event.eventId,
          errorReason: `no handler for platform ${event.platform}`,
          status: 0,
          headers: {},
          body: new Uint8Array(0),
        },
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
        "spectrum.fusor.provenance": provenance,
        ...errorAttrs(error),
      });
      return {
        reply: {
          eventId: event.eventId,
          errorReason,
          status: 0,
          headers: {},
          body: new Uint8Array(0),
        },
      };
    }

    const outcomes = await Promise.all(
      handlers.map((handler) =>
        runHandlerOnce(handler, parsedRequest, deliver, signal)
      )
    );

    const combined = combineReplies(outcomes);
    combined.eventId = event.eventId;
    const retryableFailure = outcomes.find(
      (outcome) => !outcome.ok && outcome.retryable
    );
    return {
      reply: combined,
      ...(retryableFailure && {
        retryableError: new FusorRetryableError(
          `fusor handler failed transiently for event ${event.eventId}: ${retryableFailure.errorReason ?? "unknown error"}`,
          retryableFailure.error instanceof Error
            ? { cause: retryableFailure.error }
            : undefined
        ),
      }),
    };
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeOnce();
    }
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
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

    try {
      // Startup may be loading a cursor or minting the initial token. It owns
      // disposing a provider created after stopped became true; wait for that
      // branch before taking the final session/loop snapshot.
      try {
        await this.startPromise;
      } catch {
        // The start() caller observes initialization failures; shutdown still
        // needs to reach its shared completion boundary.
      }

      this.wsSession?.close();
      if (this.connectionLoop) {
        await this.connectionLoop;
      }
      if (this.tokenProvider) {
        await this.tokenProvider.dispose();
      }
      if (this.connectionLoopError !== undefined) {
        throw this.connectionLoopError;
      }
    } finally {
      this.stopResolve?.();
      this.stopResolve = undefined;
    }
  }

  async waitStopped(): Promise<void> {
    return this.stoppedPromise;
  }
}
