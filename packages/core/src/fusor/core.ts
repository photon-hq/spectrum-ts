import { createLogger } from "@photon-ai/otel";
import type {
  InboundReply,
  RawInboundEvent,
} from "@photon-ai/proto/photon/fusor/v1/inbound";
import type { ProviderMessageRecord } from "../platform/types";
import { officialProviderInstallHint } from "../utils/provider-packages";
import { errorAttrs } from "../utils/telemetry";
import { createFusorTokenProvider, type FusorTokenProvider } from "./auth";
import { FUSOR_MESSAGES_CHANNEL, isFusorEvent } from "./event";
import { type ParsedHttpRequest, parseHttpRequest } from "./parse";
import type { FusorMessagesReturn, FusorReply, FusorVerify } from "./types";
import {
  type FusorWsSession,
  isWsAuthError,
  runFusorWsSession,
} from "./websocket";

const DEFAULT_FUSOR_WS_URL =
  "wss://fusor-ws.spectrum.photon.codes/v1/subscribe";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

const log = createLogger("spectrum.fusor");

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface RegisteredFusorHandler<TPayload = unknown> {
  messages: (ctx: {
    payload: TPayload;
    respond: (reply: FusorReply) => void;
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
  deliver: (record: ProviderMessageRecord) => void = handler.pushMessage
): Promise<HandlerOutcome> {
  return (async () => {
    try {
      const payload = await handler.verify(parsedRequest);
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
      const result = await handler.messages({ payload, respond });
      returned = true;

      routeHandlerResult(result, handler as RegisteredFusorHandler, deliver);
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, errorReason: errorText(error) };
    }
  })();
}

export interface FusorCoreOptions {
  // Optional: only the streaming transport (start) needs cloud credentials to
  // mint a token. The webhook path (processEvent) routes registered handlers
  // without them, so a webhook-only Spectrum can construct a core with
  // neither set.
  projectId?: string;
  projectSecret?: string;
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
    this.tokenProvider = await createFusorTokenProvider(
      this.options.projectId,
      this.options.projectSecret
    );
    this.connectionLoop = this.runConnectionLoop().catch((error) => {
      log.error("fusor connection loop crashed", errorAttrs(error), error);
    });
  }

  // Streaming transport: the fusor.v1.json WebSocket plane. A session that
  // runs to a clean end reconnects immediately; an errored session backs
  // off exponentially (reset on the next clean run).
  private async runConnectionLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const wsRan = await this.tryWebsocketOnce();
      if (this.stopped) {
        return;
      }
      if (wsRan) {
        attempt = 0;
        continue;
      }

      attempt += 1;
      await this.backoffSleep(this.backoffMs(attempt));
    }
  }

  // True when the stream ran to a clean end; false when it errored (the
  // loop then backs off before reconnecting).
  private async tryWebsocketOnce(): Promise<boolean> {
    try {
      await this.runWebsocketOnce();
      return true;
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
      return false;
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
  }

  // Cancelable sleep: close() clears the timer and resolves it so
  // shutdown doesn't wait out the (up to 30s) backoff.
  private async backoffSleep(backoff: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.reconnectResolve = resolve;
      const timer = setTimeout(resolve, backoff);
      timer.unref?.();
      this.reconnectTimer = timer;
    });
    this.reconnectTimer = undefined;
    this.reconnectResolve = undefined;
  }

  private async runWebsocketOnce(): Promise<void> {
    if (!this.tokenProvider) {
      throw new Error("fusor: token not initialized");
    }
    const token = await this.tokenProvider.getToken();
    const session = runFusorWsSession({
      url: this.websocketEndpoint,
      token,
      onEvent: async (event, sendReply) => {
        if (this.stopped) {
          return;
        }
        const reply = await this.processEvent(event);
        // The server answers unexpected replies with typed notices —
        // only reply when asked (sendReply is set iff replyExpected).
        sendReply?.(reply);
      },
    });
    this.wsSession = session;
    try {
      await session.done;
    } finally {
      this.wsSession = undefined;
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
    deliver?: (record: ProviderMessageRecord) => void
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
      handlers.map((handler) => runHandlerOnce(handler, parsedRequest, deliver))
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
