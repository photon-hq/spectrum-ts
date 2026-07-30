import { createLogger } from "@photon-ai/otel";
import type {
  InboundReply,
  RawInboundEvent,
} from "@photon-ai/proto/photon/fusor/v1/inbound";
import { errorAttrs } from "../utils/telemetry";

// fusor.v1.json WebSocket transport — the streaming transport.
//
// Speaks fusor-fanout-websocket's public protocol (fusor repo,
// apps/fanout-websocket/BEHAVIOR.md): a standards WebSocket at
// `wss://…/v1/subscribe`, subprotocol `fusor.v1.json`, JSON text frames.
// The cursor (`startSeq` / `event.seq`) and the reply path carry the same
// semantics the retired gRPC plane had — only the framing differed.
//
// Uses the global `WebSocket` (Bun, Node ≥ 22, browsers, workers) — no
// client library. Auth rides inside the `init` frame rather than an
// Authorization header so the transport works in runtimes that can't set
// upgrade headers.

const log = createLogger("spectrum.fusor.ws");

export const FUSOR_WS_SUBPROTOCOL = "fusor.v1.json";
export const DEFAULT_FUSOR_MAX_PENDING_EVENTS = 64;
export const DEFAULT_FUSOR_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS = 2000;
// Kept as an alias for callers/tests that imported the earlier fixed limit.
export const FUSOR_WS_MAX_PENDING_EVENTS = DEFAULT_FUSOR_MAX_PENDING_EVENTS;

// Staleness watchdog: the server sends app-level heartbeat frames (the
// cadence is advertised in `ready`); no frame of any kind for
// 2 × interval + grace means a dead intermediary — fail the session and
// let the core's reconnect loop take over. The pre-`ready` budget also
// bounds how long we wait for the server to acknowledge the init.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const STALENESS_GRACE_MS = 5000;
const LOCAL_CLOSE_TIMEOUT_MS = 2000;

export class FusorWsError extends Error {
  readonly closeCode?: number;
  readonly errorCode?: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;

  constructor(
    message: string,
    closeCode?: number,
    errorCode?: string,
    reason?: string,
    retryable?: boolean,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = "FusorWsError";
    this.closeCode = closeCode;
    this.errorCode = errorCode;
    this.reason = reason;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// A stale/expired token surfaces as a typed `unauthenticated` error frame
// + close 4401; detect it so the reconnect path can drop the cached token
// before retrying.
export function isWsAuthError(error: unknown): boolean {
  return (
    error instanceof FusorWsError &&
    (error.closeCode === 4401 || error.errorCode === "unauthenticated")
  );
}

/** A server verifier invariant, not a rejected credential to re-mint. */
export function isWsTerminalAuthError(error: unknown): boolean {
  return (
    error instanceof FusorWsError &&
    error.errorCode === "unauthenticated" &&
    error.reason === "jwt:not-initialized"
  );
}

/** A fatal server/client protocol condition that reconnecting cannot repair. */
export function isWsTerminalError(error: unknown): boolean {
  if (!(error instanceof FusorWsError)) {
    return false;
  }
  if (isWsTerminalAuthError(error)) {
    return true;
  }
  // A rejected credential is the one retryable=false server response that the
  // client can repair itself by minting a fresh token.
  if (isWsAuthError(error)) {
    return false;
  }
  return error.retryable === false || error.closeCode === 1009;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  // Chunked: one String.fromCharCode call per slice stays under the
  // engine's argument-count limit and avoids quadratic string growth
  // on large reply bodies.
  const chunkSize = 0x80_00;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(""));
}

function utf8ByteLength(value: string): number {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(value, "utf8");
  }
  return new TextEncoder().encode(value).byteLength;
}

interface WsEventFrame {
  event: {
    eventId: string;
    projectId: string;
    platform: string;
    receivedAt?: string;
    sourceId?: string;
    prevSubjectSeq: number;
    rawRequest: string;
  };
  replyExpected?: boolean;
  seq: number;
  type: "event";
}

function toRawInboundEvent(frame: WsEventFrame): RawInboundEvent {
  const e = frame.event;
  return {
    eventId: e.eventId,
    projectId: e.projectId,
    platform: e.platform,
    receivedAt: e.receivedAt ? new Date(e.receivedAt) : undefined,
    sourceId: e.sourceId ?? "",
    prevSubjectSeq: e.prevSubjectSeq ?? 0,
    rawRequest: decodeBase64(e.rawRequest),
  };
}

export interface FusorWsSessionOptions {
  /** Maximum UTF-8 wire bytes held by admitted event frames. */
  maxPendingBytes?: number;
  /** Maximum admitted events, including the event currently being handled. */
  maxPendingEvents?: number;
  /**
   * Called for every event frame, in arrival order. `sendReply` is set
   * only when the server flagged `replyExpected` — replying to anything
   * else earns a (non-fatal) `reply_unknown_event` notice from the
   * server, so the core must not fire blind replies. `seq` is the global
   * stream cursor for this delivery; callers must checkpoint it only after
   * this promise resolves successfully.
   */
  onEvent: (
    event: RawInboundEvent,
    sendReply: ((reply: InboundReply) => void) | undefined,
    seq: number,
    signal: AbortSignal
  ) => Promise<void>;
  /** Called once when the server acknowledges the subscription as ready. */
  onReady?: () => void;
  /** Called when the underlying transport reports that it has closed. */
  onTransportClose?: () => void;
  /** Maximum time close waits for an in-flight event handler to return. */
  shutdownTimeoutMs?: number;
  /** Last transport-completed global stream sequence; defaults to live tail. */
  startSeq?: number;
  token: string;
  url: string;
}

export interface FusorWsSession {
  close(): void;
  /** Resolves on `close()`; rejects when the session dies on its own. */
  done: Promise<void>;
}

export function runFusorWsSession(
  options: FusorWsSessionOptions
): FusorWsSession {
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new FusorWsError(
      "global WebSocket is not available in this runtime — the fusor websocket transport needs Bun, Node >= 22, or a browser/worker environment",
      undefined,
      "websocket_unavailable",
      undefined,
      false
    );
  }

  // Off the constructor (not the global) — module-level `WebSocket.OPEN`
  // would crash runtimes where the global is missing before the friendly
  // error above can fire.
  const wsOpen = WebSocketCtor.OPEN;

  // Optional for source compatibility with callers of the original session
  // helper; the core always supplies its explicit safe checkpoint.
  const startSeq = options.startSeq ?? 0;
  if (
    !Number.isSafeInteger(startSeq) ||
    startSeq < 0 ||
    startSeq >= Number.MAX_SAFE_INTEGER
  ) {
    throw new FusorWsError(
      "fusor websocket startSeq must be a non-negative safe integer below Number.MAX_SAFE_INTEGER",
      undefined,
      "invalid_start_seq",
      undefined,
      false
    );
  }

  const maxPendingEvents =
    options.maxPendingEvents ?? DEFAULT_FUSOR_MAX_PENDING_EVENTS;
  const maxPendingBytes =
    options.maxPendingBytes ?? DEFAULT_FUSOR_MAX_PENDING_BYTES;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS;
  for (const [name, value] of [
    ["maxPendingEvents", maxPendingEvents],
    ["maxPendingBytes", maxPendingBytes],
    ["shutdownTimeoutMs", shutdownTimeoutMs],
  ] as const) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new FusorWsError(
        `fusor websocket ${name} must be a positive safe integer`,
        undefined,
        "invalid_client_option",
        undefined,
        false
      );
    }
  }

  const ws = new WebSocketCtor(options.url, [FUSOR_WS_SUBPROTOCOL]);

  let settled = false;
  let closedByUs = false;
  let closing = false;
  let drainError: Error | undefined;
  let pendingLocalError: Error | undefined;
  // Last fatal `error` frame — the close event that follows carries only
  // a code, so this is what makes the rejection actionable.
  let pendingError: {
    code: string;
    message: string;
    reason?: string;
    retryAfterMs?: number;
    retryable?: boolean;
  } | null = null;
  let readyNotified = false;
  let transportCloseNotified = false;
  let stalenessBudgetMs =
    2 * DEFAULT_HEARTBEAT_INTERVAL_MS + STALENESS_GRACE_MS;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let closeFailsafe: ReturnType<typeof setTimeout> | undefined;
  const processingAbort = new AbortController();
  interface PendingEvent {
    byteLength: number;
    event: RawInboundEvent;
    sendReply: ((reply: InboundReply) => void) | undefined;
    seq: number;
  }
  const pendingEvents: PendingEvent[] = [];
  let pendingEventCount = 0;
  let pendingEventBytes = 0;
  let worker: Promise<void> | undefined;

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const stopProcessing = (): void => {
    processingAbort.abort();
    for (const pending of pendingEvents.splice(0)) {
      pendingEventCount -= 1;
      pendingEventBytes -= pending.byteLength;
    }
  };

  // `done` is also the processing-drain boundary. A transport close aborts
  // the active handler and drops queued work for retained replay. Cooperative
  // handlers drain normally; an uncooperative one is detached after the
  // bounded shutdown deadline and can no longer reply or checkpoint.
  const settle = (error?: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    stopProcessing();
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    if (closeFailsafe) {
      clearTimeout(closeFailsafe);
      closeFailsafe = undefined;
    }
    const activeWorker = worker;
    if (!activeWorker) {
      if (error) {
        rejectDone(error);
      } else {
        resolveDone();
      }
      return;
    }

    let processingSettled = false;
    const finish = (workerError?: unknown): void => {
      if (processingSettled) {
        return;
      }
      processingSettled = true;
      clearTimeout(shutdownTimer);
      if (workerError !== undefined) {
        rejectDone(
          workerError instanceof Error
            ? workerError
            : new FusorWsError(String(workerError))
        );
      } else if (error) {
        rejectDone(error);
      } else {
        resolveDone();
      }
    };
    const shutdownTimer = setTimeout(() => {
      log.warn("fusor ws: event handler exceeded shutdown deadline", {
        "spectrum.fusor.ws.shutdown_timeout_ms": shutdownTimeoutMs,
      });
      finish();
    }, shutdownTimeoutMs);
    activeWorker.then(
      () => {
        finish();
      },
      (handlerError: unknown) => {
        finish(handlerError);
      }
    );
  };

  const closeTimeoutError = (error?: Error): Error => {
    const timeoutError = new FusorWsError(
      "fusor websocket close handshake timed out"
    );
    if (!error) {
      return timeoutError;
    }
    if (!(error instanceof FusorWsError)) {
      return new FusorWsError(`${error.message}; ${timeoutError.message}`);
    }
    return new FusorWsError(
      `${error.message}; ${timeoutError.message}`,
      error.closeCode,
      error.errorCode,
      error.reason,
      error.retryable,
      error.retryAfterMs
    );
  };

  const closeTransport = (error?: Error): void => {
    if (settled) {
      return;
    }
    if (closing) {
      pendingLocalError ??= error;
      return;
    }
    closing = true;
    pendingLocalError = error;
    stopProcessing();
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    if (settled) {
      return;
    }
    closeFailsafe = setTimeout(() => {
      settle(closeTimeoutError(pendingLocalError));
    }, LOCAL_CLOSE_TIMEOUT_MS);
  };

  // Backpressure is different from shutdown: stop admitting frames, finish the
  // already-bounded ordered prefix while the socket can still carry replies,
  // then reconnect from its new safe cursor. Aborting that prefix would lose
  // live-tail deliveries (startSeq=0) and can livelock retained replay.
  const reconnectAfterDrain = (error: Error): void => {
    if (settled || closing || drainError) {
      return;
    }
    drainError = error;
    const activeWorker = worker;
    if (!activeWorker) {
      drainError = undefined;
      closeTransport(error);
      return;
    }
    activeWorker.then(
      () => {
        if (settled || closing) {
          return;
        }
        const drainedError = drainError;
        drainError = undefined;
        closeTransport(drainedError);
      },
      () => {
        // processPendingEvent already failed the session with the more useful
        // handler/checkpoint error.
      }
    );
  };

  const failSession = (error: Error): void => {
    closeTransport(error);
  };

  const armWatchdog = (): void => {
    if (settled) {
      return;
    }
    if (watchdog) {
      clearTimeout(watchdog);
    }
    watchdog = setTimeout(() => {
      log.warn("fusor ws: no frame within staleness budget; closing", {
        "spectrum.fusor.ws.staleness_budget_ms": stalenessBudgetMs,
      });
      failSession(new FusorWsError("websocket heartbeat timeout"));
    }, stalenessBudgetMs);
    watchdog.unref?.();
  };

  const sendReplyFor =
    (eventId: string): ((reply: InboundReply) => void) =>
    (reply) => {
      if (ws.readyState !== wsOpen) {
        return;
      }
      ws.send(
        JSON.stringify({
          type: "reply",
          eventId,
          status: reply.status,
          headers: reply.headers,
          ...(reply.body.length > 0 && { body: encodeBase64(reply.body) }),
          ...(reply.errorReason && { errorReason: reply.errorReason }),
        })
      );
    };

  const handleReadyFrame = (frame: Record<string, unknown>): void => {
    const interval = frame.heartbeatIntervalMs;
    if (typeof interval === "number" && interval > 0) {
      stalenessBudgetMs = 2 * interval + STALENESS_GRACE_MS;
    }
    log.info("fusor ws stream ready", {
      "spectrum.fusor.ws.project_id":
        typeof frame.projectId === "string" ? frame.projectId : "",
      "spectrum.fusor.ws.heartbeat_interval_ms":
        typeof interval === "number" ? interval : 0,
    });
    if (!readyNotified) {
      readyNotified = true;
      options.onReady?.();
    }
  };

  const processPendingEvent = async (
    pending: PendingEvent
  ): Promise<boolean> => {
    try {
      if (processingAbort.signal.aborted) {
        return false;
      }
      await options.onEvent(
        pending.event,
        pending.sendReply,
        pending.seq,
        processingAbort.signal
      );
      return !processingAbort.signal.aborted;
    } catch (error) {
      const isCheckpointFailure =
        error instanceof FusorWsError &&
        error.errorCode === "checkpoint_failed";
      if (processingAbort.signal.aborted && !isCheckpointFailure) {
        return false;
      }
      const failure =
        error instanceof Error ? error : new FusorWsError(String(error));
      log.warn(
        "fusor ws: event handler failed",
        {
          "spectrum.fusor.ws.event_id": pending.event.eventId,
          ...errorAttrs(error),
        },
        error
      );
      failSession(failure);
      throw failure;
    } finally {
      pendingEventCount -= 1;
      pendingEventBytes -= pending.byteLength;
    }
  };

  const processPendingEvents = async (): Promise<void> => {
    while (!processingAbort.signal.aborted) {
      const pending = pendingEvents.shift();
      if (!(pending && (await processPendingEvent(pending)))) {
        return;
      }
    }
  };

  const startEventWorker = (): void => {
    if (worker || closing || settled) {
      return;
    }
    worker = processPendingEvents().finally(() => {
      worker = undefined;
      if (pendingEvents.length > 0 && !(closing || settled)) {
        startEventWorker();
      }
    });
    worker.catch(() => undefined);
  };

  const handleEventFrame = (
    frame: Record<string, unknown>,
    byteLength: number
  ): void => {
    const eventFrame = frame as unknown as WsEventFrame;
    const seq = eventFrame.seq;
    if (
      !Number.isSafeInteger(seq) ||
      seq <= 0 ||
      seq >= Number.MAX_SAFE_INTEGER
    ) {
      failSession(
        new FusorWsError(
          "fusor websocket event seq must be a positive safe integer below Number.MAX_SAFE_INTEGER",
          undefined,
          "event_invalid",
          undefined,
          false
        )
      );
      return;
    }
    let event: RawInboundEvent;
    try {
      event = toRawInboundEvent(eventFrame);
    } catch (error) {
      log.warn(
        "fusor ws: undecodable event frame; failing session",
        errorAttrs(error),
        error
      );
      failSession(
        new FusorWsError(
          `fusor websocket event frame is undecodable: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          "event_invalid",
          undefined,
          false
        )
      );
      return;
    }
    const sendReply = eventFrame.replyExpected
      ? sendReplyFor(event.eventId)
      : undefined;
    const nextEventCount = pendingEventCount + 1;
    const nextEventBytes = pendingEventBytes + byteLength;
    if (nextEventCount > maxPendingEvents || nextEventBytes > maxPendingBytes) {
      log.warn("fusor ws: pending event backlog overflow; reconnecting", {
        "spectrum.fusor.ws.pending_events": pendingEventCount,
        "spectrum.fusor.ws.pending_bytes": pendingEventBytes,
        "spectrum.fusor.ws.incoming_event_bytes": byteLength,
        "spectrum.fusor.ws.max_pending_events": maxPendingEvents,
        "spectrum.fusor.ws.max_pending_bytes": maxPendingBytes,
      });
      reconnectAfterDrain(
        new FusorWsError(
          "fusor websocket pending event backlog exceeded its admission limit",
          undefined,
          "client_backpressure",
          undefined,
          true
        )
      );
      return;
    }

    pendingEventCount = nextEventCount;
    pendingEventBytes = nextEventBytes;
    pendingEvents.push({ byteLength, event, sendReply, seq });
    startEventWorker();
  };

  const handleErrorFrame = (frame: Record<string, unknown>): void => {
    const code = typeof frame.code === "string" ? frame.code : "unknown";
    const message =
      typeof frame.message === "string" ? frame.message : "server error";
    const reason = typeof frame.reason === "string" ? frame.reason : undefined;
    const retryAfterMs =
      typeof frame.retryAfterMs === "number" &&
      Number.isSafeInteger(frame.retryAfterMs) &&
      frame.retryAfterMs >= 0
        ? frame.retryAfterMs
        : undefined;
    if (frame.fatal === true) {
      pendingError = {
        code,
        message,
        reason,
        retryAfterMs,
        retryable:
          typeof frame.retryable === "boolean" ? frame.retryable : undefined,
      };
    } else {
      // Typed non-fatal notice (reply_unknown_event, frame_invalid, …)
      // — the stream keeps running; surface it for debugging.
      log.warn("fusor ws: server notice", {
        "spectrum.fusor.ws.notice_code": code,
        "spectrum.fusor.ws.notice_message": message,
        "spectrum.fusor.ws.notice_reason": reason,
      });
    }
  };

  const handleFrame = (raw: unknown): void => {
    if (typeof raw !== "string") {
      // The protocol is text-only; ignore anything else.
      return;
    }
    let frame: { type?: string } & Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      log.warn("fusor ws: unparseable server frame; ignoring");
      return;
    }
    switch (frame.type) {
      case "ready":
        handleReadyFrame(frame);
        return;
      case "event":
        handleEventFrame(frame, utf8ByteLength(raw));
        return;
      case "error":
        handleErrorFrame(frame);
        return;
      default:
        // heartbeat / pong / unknown forward-compat types: receipt alone
        // resets the watchdog (handled in onmessage).
        return;
    }
  };

  ws.onopen = () => {
    if (settled || closing) {
      try {
        ws.close(1000);
      } catch {
        // Already closing.
      }
      return;
    }
    armWatchdog();
    ws.send(
      JSON.stringify({
        type: "init",
        startSeq,
        token: options.token,
      })
    );
  };

  ws.onmessage = (messageEvent: MessageEvent) => {
    if (settled || closing || drainError) {
      return;
    }
    armWatchdog();
    handleFrame(messageEvent.data);
  };

  ws.onerror = () => {
    // Detail-free by spec; the close event that follows carries the code.
    log.debug("fusor ws: socket error event");
  };

  ws.onclose = (closeEvent: CloseEvent) => {
    if (!transportCloseNotified) {
      transportCloseNotified = true;
      options.onTransportClose?.();
    }
    if (pendingLocalError) {
      settle(pendingLocalError);
      return;
    }
    if (closedByUs) {
      settle();
      return;
    }
    const detail = pendingError
      ? `${pendingError.code}${pendingError.reason ? `:${pendingError.reason}` : ""} — ${pendingError.message}`
      : closeEvent.reason || "connection closed";
    settle(
      new FusorWsError(
        `fusor websocket closed (${closeEvent.code}): ${detail}`,
        closeEvent.code,
        pendingError?.code ?? (closeEvent.reason || undefined),
        pendingError?.reason,
        pendingError?.retryable,
        pendingError?.retryAfterMs
      )
    );
  };

  // Pre-open watchdog: also bounds a connect that never completes.
  armWatchdog();

  return {
    done,
    close() {
      if (closedByUs || closing) {
        return;
      }
      closedByUs = true;
      closeTransport();
    },
  };
}
