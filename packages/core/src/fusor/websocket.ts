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
export const FUSOR_WS_MAX_PENDING_EVENTS = 1024;

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
  readonly retryable?: boolean;

  constructor(
    message: string,
    closeCode?: number,
    errorCode?: string,
    reason?: string,
    retryable?: boolean
  ) {
    super(message);
    this.name = "FusorWsError";
    this.closeCode = closeCode;
    this.errorCode = errorCode;
    this.reason = reason;
    this.retryable = retryable;
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
    seq: number
  ) => Promise<void>;
  /** Called once when the server acknowledges the subscription as ready. */
  onReady?: () => void;
  /** Called when the underlying transport reports that it has closed. */
  onTransportClose?: () => void;
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

  const ws = new WebSocketCtor(options.url, [FUSOR_WS_SUBPROTOCOL]);

  let settled = false;
  let closedByUs = false;
  let closing = false;
  let pendingLocalError: Error | undefined;
  // Last fatal `error` frame — the close event that follows carries only
  // a code, so this is what makes the rejection actionable.
  let pendingError: {
    code: string;
    message: string;
    reason?: string;
    retryable?: boolean;
  } | null = null;
  let readyNotified = false;
  let transportCloseNotified = false;
  let stalenessBudgetMs =
    2 * DEFAULT_HEARTBEAT_INTERVAL_MS + STALENESS_GRACE_MS;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let closeFailsafe: ReturnType<typeof setTimeout> | undefined;
  // Events are processed strictly in arrival order even though the
  // handler is async (same discipline as the server side).
  let tail: Promise<void> = Promise.resolve();
  let pendingEventCount = 0;

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // `done` is also the processing-drain boundary. A transport close may race
  // an async handler that already received an event; reconnecting before that
  // handler settles could replay it concurrently or checkpoint past it. Mark
  // the transport settled immediately (so no new frames are accepted), then
  // resolve/reject only after the ordered handler tail has drained.
  const settle = (error?: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    if (closeFailsafe) {
      clearTimeout(closeFailsafe);
      closeFailsafe = undefined;
    }
    tail.then(
      () => {
        if (error) {
          rejectDone(error);
        } else {
          resolveDone();
        }
      },
      (handlerError: unknown) => {
        rejectDone(
          handlerError instanceof Error
            ? handlerError
            : new FusorWsError(String(handlerError))
        );
      }
    );
  };

  const closeTransport = (error?: Error): void => {
    if (settled || closing) {
      return;
    }
    closing = true;
    pendingLocalError = error;
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    if (settled) {
      return;
    }
    closeFailsafe = setTimeout(() => {
      const timeoutError = new FusorWsError(
        "fusor websocket close handshake timed out"
      );
      settle(
        pendingLocalError
          ? new FusorWsError(
              `${pendingLocalError.message}; ${timeoutError.message}`,
              pendingLocalError instanceof FusorWsError
                ? pendingLocalError.closeCode
                : undefined,
              pendingLocalError instanceof FusorWsError
                ? pendingLocalError.errorCode
                : undefined,
              pendingLocalError instanceof FusorWsError
                ? pendingLocalError.reason
                : undefined,
              pendingLocalError instanceof FusorWsError
                ? pendingLocalError.retryable
                : undefined
            )
          : timeoutError
      );
    }, LOCAL_CLOSE_TIMEOUT_MS);
    closeFailsafe.unref?.();
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

  const handleEventFrame = (frame: Record<string, unknown>): void => {
    if (pendingEventCount >= FUSOR_WS_MAX_PENDING_EVENTS) {
      failSession(
        new FusorWsError(
          `fusor websocket pending-event limit (${FUSOR_WS_MAX_PENDING_EVENTS}) exceeded`,
          undefined,
          "client_backpressure",
          undefined,
          true
        )
      );
      return;
    }
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
    // Do not recover this chain after a handler failure. Every later event was
    // delivered after the failed one, so processing it and advancing the core
    // cursor would skip the failed delivery. Failing the session reconnects
    // from the last earlier safe cursor instead.
    pendingEventCount += 1;
    const next = tail.then(() => options.onEvent(event, sendReply, seq));
    tail = next;
    next.then(
      () => {
        pendingEventCount -= 1;
      },
      (error) => {
        pendingEventCount -= 1;
        if (!settled) {
          log.warn(
            "fusor ws: event handler failed",
            {
              "spectrum.fusor.ws.event_id": event.eventId,
              ...errorAttrs(error),
            },
            error
          );
          failSession(
            error instanceof Error ? error : new FusorWsError(String(error))
          );
        }
      }
    );
  };

  const handleErrorFrame = (frame: Record<string, unknown>): void => {
    const code = typeof frame.code === "string" ? frame.code : "unknown";
    const message =
      typeof frame.message === "string" ? frame.message : "server error";
    const reason = typeof frame.reason === "string" ? frame.reason : undefined;
    if (frame.fatal === true) {
      pendingError = {
        code,
        message,
        reason,
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
        handleEventFrame(frame);
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
    if (settled || closing) {
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
        pendingError?.retryable
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
