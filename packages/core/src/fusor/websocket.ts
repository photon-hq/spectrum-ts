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

// Staleness watchdog: the server sends app-level heartbeat frames (the
// cadence is advertised in `ready`); no frame of any kind for
// 2 × interval + grace means a dead intermediary — fail the session and
// let the core's reconnect loop take over. The pre-`ready` budget also
// bounds how long we wait for the server to acknowledge the init.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const STALENESS_GRACE_MS = 5000;
export const DEFAULT_FUSOR_MAX_PENDING_EVENTS = 64;
export const DEFAULT_FUSOR_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FUSOR_SHUTDOWN_TIMEOUT_MS = 2000;

export class FusorWsError extends Error {
  readonly closeCode?: number;
  readonly errorCode?: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    closeCode?: number,
    errorCode?: string,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = "FusorWsError";
    this.closeCode = closeCode;
    this.errorCode = errorCode;
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
   * server, so the core must not fire blind replies.
   */
  onEvent: (
    event: RawInboundEvent,
    seq: number,
    sendReply: ((reply: InboundReply) => void) | undefined,
    signal: AbortSignal
  ) => Promise<void>;
  onReady?: () => void;
  /** Maximum time close waits for an in-flight event handler to return. */
  shutdownTimeoutMs?: number;
  startSeq: number;
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
      "global WebSocket is not available in this runtime — the fusor websocket transport needs Bun, Node >= 22, or a browser/worker environment"
    );
  }

  // Off the constructor (not the global) — module-level `WebSocket.OPEN`
  // would crash runtimes where the global is missing before the friendly
  // error above can fire.
  const wsOpen = WebSocketCtor.OPEN;

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
      throw new FusorWsError(`fusor ws: ${name} must be a positive integer`);
    }
  }

  const ws = new WebSocketCtor(options.url, [FUSOR_WS_SUBPROTOCOL]);

  let settled = false;
  let finishStarted = false;
  let closedByUs = false;
  // Last fatal `error` frame — the close event that follows carries only
  // a code, so this is what makes the rejection actionable.
  let pendingError: {
    code: string;
    message: string;
    reason?: string;
    retryAfterMs?: number;
  } | null = null;
  let stalenessBudgetMs =
    2 * DEFAULT_HEARTBEAT_INTERVAL_MS + STALENESS_GRACE_MS;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const processingAbort = new AbortController();
  interface PendingEvent {
    byteLength: number;
    frame: WsEventFrame;
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
  const settle = (error?: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    if (error) {
      rejectDone(error);
    } else {
      resolveDone();
    }
  };

  const finish = (error?: Error): void => {
    if (finishStarted) {
      return;
    }
    finishStarted = true;
    processingAbort.abort();
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    // Queued frames have not entered application code and must be replayed
    // from the durable cursor on the next session. Release them immediately;
    // only the single in-flight handler can remain after this point.
    for (const pending of pendingEvents.splice(0)) {
      pendingEventCount -= 1;
      pendingEventBytes -= pending.byteLength;
    }
    const activeWorker = worker;
    if (!activeWorker) {
      settle(error);
      return;
    }
    const shutdownTimer = setTimeout(() => {
      log.warn("fusor ws: event handler exceeded shutdown deadline", {
        "spectrum.fusor.ws.shutdown_timeout_ms": shutdownTimeoutMs,
      });
      settle(error);
    }, shutdownTimeoutMs);
    // Keep this referenced. On an overload failure the socket may already be
    // the process's last other handle, and the deadline must fire so the core
    // can enter its reconnect loop. Intentional shutdown is bounded by the
    // same short deadline.
    activeWorker.then(
      () => {
        clearTimeout(shutdownTimer);
        settle(error);
      },
      (workerError: unknown) => {
        clearTimeout(shutdownTimer);
        settle(
          workerError instanceof Error
            ? workerError
            : new FusorWsError(String(workerError))
        );
      }
    );
  };

  const armWatchdog = (): void => {
    if (settled || finishStarted) {
      return;
    }
    if (watchdog) {
      clearTimeout(watchdog);
    }
    watchdog = setTimeout(() => {
      log.warn("fusor ws: no frame within staleness budget; closing", {
        "spectrum.fusor.ws.staleness_budget_ms": stalenessBudgetMs,
      });
      finish(new FusorWsError("websocket heartbeat timeout"));
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }, stalenessBudgetMs);
    watchdog.unref?.();
  };

  const sendReplyFor =
    (eventId: string): ((reply: InboundReply) => void) =>
    (reply) => {
      if (ws.readyState !== wsOpen) {
        throw new FusorWsError(
          `fusor ws: cannot queue reply for ${eventId}; socket is not open`
        );
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
    options.onReady?.();
  };

  const processPendingEvent = async (
    pending: PendingEvent
  ): Promise<boolean> => {
    const eventFrame = pending.frame;
    try {
      if (!Number.isSafeInteger(eventFrame.seq) || eventFrame.seq <= 0) {
        throw new FusorWsError("fusor ws: invalid event sequence");
      }
      const event = toRawInboundEvent(eventFrame);
      const sendReply = eventFrame.replyExpected
        ? sendReplyFor(event.eventId)
        : undefined;
      await options.onEvent(
        event,
        eventFrame.seq,
        sendReply,
        processingAbort.signal
      );
      return true;
    } catch (error) {
      const failure =
        error instanceof Error ? error : new FusorWsError(String(error));
      log.warn(
        "fusor ws: event handler failed",
        {
          "spectrum.fusor.ws.event_id": eventFrame.event?.eventId ?? "",
          ...errorAttrs(error),
        },
        error
      );
      try {
        ws.close(1011, "event handler failed");
      } catch {
        // Already closing.
      }
      finish(failure);
      return false;
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
    if (worker || finishStarted) {
      return;
    }
    worker = processPendingEvents().finally(() => {
      worker = undefined;
      if (pendingEvents.length > 0 && !finishStarted) {
        startEventWorker();
      }
    });
    worker.catch(() => undefined);
  };

  const handleEventFrame = (
    frame: Record<string, unknown>,
    byteLength: number
  ): void => {
    if (finishStarted) {
      return;
    }
    const nextEventCount = pendingEventCount + 1;
    const nextEventBytes = pendingEventBytes + byteLength;
    if (nextEventCount > maxPendingEvents || nextEventBytes > maxPendingBytes) {
      const failure = new FusorWsError(
        "fusor ws: pending event backlog exceeded its admission limit",
        1013,
        "event_backlog_overflow"
      );
      log.warn("fusor ws: pending event backlog overflow; reconnecting", {
        "spectrum.fusor.ws.pending_events": pendingEventCount,
        "spectrum.fusor.ws.pending_bytes": pendingEventBytes,
        "spectrum.fusor.ws.incoming_event_bytes": byteLength,
        "spectrum.fusor.ws.max_pending_events": maxPendingEvents,
        "spectrum.fusor.ws.max_pending_bytes": maxPendingBytes,
      });
      finish(failure);
      try {
        ws.close(1013, "event backlog overflow");
      } catch {
        // Already closing.
      }
      return;
    }
    pendingEventCount = nextEventCount;
    pendingEventBytes = nextEventBytes;
    pendingEvents.push({
      byteLength,
      frame: frame as unknown as WsEventFrame,
    });
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
      pendingError = { code, message, reason, retryAfterMs };
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
    armWatchdog();
    ws.send(
      JSON.stringify({
        type: "init",
        startSeq: options.startSeq,
        token: options.token,
      })
    );
  };

  ws.onmessage = (messageEvent: MessageEvent) => {
    armWatchdog();
    handleFrame(messageEvent.data);
  };

  ws.onerror = () => {
    // Detail-free by spec; the close event that follows carries the code.
    log.debug("fusor ws: socket error event");
  };

  ws.onclose = (closeEvent: CloseEvent) => {
    if (closedByUs) {
      finish();
      return;
    }
    const detail = pendingError
      ? `${pendingError.code}${pendingError.reason ? `:${pendingError.reason}` : ""} — ${pendingError.message}`
      : closeEvent.reason || "connection closed";
    finish(
      new FusorWsError(
        `fusor websocket closed (${closeEvent.code}): ${detail}`,
        closeEvent.code,
        pendingError?.code ?? (closeEvent.reason || undefined),
        pendingError?.retryAfterMs
      )
    );
  };

  // Pre-open watchdog: also bounds a connect that never completes.
  armWatchdog();

  return {
    done,
    close() {
      closedByUs = true;
      finish();
      try {
        ws.close(1000);
      } catch {
        // Already closed.
      }
    },
  };
}
