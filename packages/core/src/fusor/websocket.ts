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

export class FusorWsError extends Error {
  readonly closeCode?: number;
  readonly errorCode?: string;

  constructor(message: string, closeCode?: number, errorCode?: string) {
    super(message);
    this.name = "FusorWsError";
    this.closeCode = closeCode;
    this.errorCode = errorCode;
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
   * server, so the core must not fire blind replies.
   */
  onEvent: (
    event: RawInboundEvent,
    sendReply: ((reply: InboundReply) => void) | undefined
  ) => Promise<void>;
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

  const ws = new WebSocketCtor(options.url, [FUSOR_WS_SUBPROTOCOL]);

  let settled = false;
  let closedByUs = false;
  // Last fatal `error` frame — the close event that follows carries only
  // a code, so this is what makes the rejection actionable.
  let pendingError: { code: string; message: string; reason?: string } | null =
    null;
  let stalenessBudgetMs =
    2 * DEFAULT_HEARTBEAT_INTERVAL_MS + STALENESS_GRACE_MS;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // Events are processed strictly in arrival order even though the
  // handler is async (same discipline as the server side).
  let tail: Promise<void> = Promise.resolve();

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
      settle(new FusorWsError("websocket heartbeat timeout"));
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
  };

  const handleEventFrame = (frame: Record<string, unknown>): void => {
    const eventFrame = frame as unknown as WsEventFrame;
    let event: RawInboundEvent;
    try {
      event = toRawInboundEvent(eventFrame);
    } catch (error) {
      log.warn(
        "fusor ws: undecodable event frame; skipping",
        errorAttrs(error),
        error
      );
      return;
    }
    const sendReply = eventFrame.replyExpected
      ? sendReplyFor(event.eventId)
      : undefined;
    tail = tail
      .then(() => options.onEvent(event, sendReply))
      .catch((error) => {
        log.warn(
          "fusor ws: event handler failed",
          { "spectrum.fusor.ws.event_id": event.eventId, ...errorAttrs(error) },
          error
        );
      });
  };

  const handleErrorFrame = (frame: Record<string, unknown>): void => {
    const code = typeof frame.code === "string" ? frame.code : "unknown";
    const message =
      typeof frame.message === "string" ? frame.message : "server error";
    const reason = typeof frame.reason === "string" ? frame.reason : undefined;
    if (frame.fatal === true) {
      pendingError = { code, message, reason };
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
    armWatchdog();
    ws.send(
      JSON.stringify({ type: "init", startSeq: 0, token: options.token })
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
        pendingError?.code ?? (closeEvent.reason || undefined)
      )
    );
  };

  // Pre-open watchdog: also bounds a connect that never completes.
  armWatchdog();

  return {
    done,
    close() {
      closedByUs = true;
      try {
        ws.close(1000);
      } catch {
        // Already closed.
      }
      // Some runtimes skip the close event for never-opened sockets;
      // don't let done hang on shutdown.
      const failsafe = setTimeout(() => settle(), 2000);
      failsafe.unref?.();
    },
  };
}
