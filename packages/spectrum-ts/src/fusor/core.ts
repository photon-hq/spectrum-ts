import { ChannelCredentials } from "@grpc/grpc-js";
import { createLogger } from "@photon-ai/otel";
import type {
  InboundReply,
  RawInboundEvent,
} from "@photon-ai/proto/photon/fusor/v1/inbound";
import { type Channel, createChannel, createClient } from "nice-grpc";
import { ClientError, Metadata, Status } from "nice-grpc-common";
import type { ProviderMessageRecord } from "../platform/types";
import { createFusorTokenProvider, type FusorTokenProvider } from "./auth";
import { FUSOR_MESSAGES_CHANNEL, isFusorEvent } from "./event";
import { type ParsedHttpRequest, parseHttpRequest } from "./parse";
import {
  EventsServiceDefinition,
  type SubscribeRequest,
  type SubscribeResponse,
} from "./service";
import type { FusorMessagesReturn, FusorReply, FusorVerify } from "./types";

const DEFAULT_FUSOR_GRPC_URL = "fusor.spectrum.photon.codes:443";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

const log = createLogger("spectrum.fusor");

// A stale/expired stream token surfaces as a gRPC UNAUTHENTICATED error; detect
// it so the reconnect path can drop the cached token before retrying.
function isAuthError(error: unknown): boolean {
  return error instanceof ClientError && error.code === Status.UNAUTHENTICATED;
}

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

interface RequestSink {
  close(): void;
  push(req: SubscribeRequest): void;
}

function createRequestSink(): {
  iterable: AsyncIterable<SubscribeRequest>;
  sink: RequestSink;
} {
  const buffer: SubscribeRequest[] = [];
  const resolvers: ((
    result: IteratorResult<SubscribeRequest, undefined>
  ) => void)[] = [];
  let closed = false;

  const sink: RequestSink = {
    push(req) {
      if (closed) {
        return;
      }
      const resolver = resolvers.shift();
      if (resolver) {
        resolver({ value: req, done: false });
      } else {
        buffer.push(req);
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.({ value: undefined, done: true });
      }
    },
  };

  const iterable: AsyncIterable<SubscribeRequest> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SubscribeRequest, undefined>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as SubscribeRequest;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            resolvers.push(resolve);
          });
        },
        return(): Promise<IteratorResult<SubscribeRequest, undefined>> {
          sink.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { iterable, sink };
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
      const errorReason =
        error instanceof Error ? error.message : String(error);
      return { ok: false, errorReason };
    }
  })();
}

export interface FusorCoreOptions {
  endpoint?: string;
  // Optional: only the gRPC stream (start) needs cloud credentials to mint a
  // token. The webhook path (processEvent) routes registered handlers without
  // them, so a webhook-only Spectrum can construct a core with neither set.
  projectId?: string;
  projectSecret?: string;
}

export class FusorCore {
  private readonly options: FusorCoreOptions;
  private readonly endpoint: string;
  private readonly handlers = new Map<string, RegisteredFusorHandler[]>();
  private channel?: Channel;
  private tokenProvider?: FusorTokenProvider;
  private requestSink?: RequestSink;
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
    this.endpoint =
      options.endpoint ??
      process.env.SPECTRUM_FUSOR_GRPC_URL ??
      DEFAULT_FUSOR_GRPC_URL;
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
    this.channel = createChannel(this.endpoint, ChannelCredentials.createSsl());
    this.connectionLoop = this.runConnectionLoop().catch((error) => {
      log.error("fusor connection loop crashed", { error });
    });
  }

  private async runConnectionLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.runOnce();
        attempt = 0;
      } catch (error) {
        if (this.stopped) {
          return;
        }
        attempt += 1;
        // Drop a stale token on auth failure so the next runOnce() mints a
        // fresh one instead of replaying the rejected token.
        if (isAuthError(error)) {
          this.tokenProvider?.invalidate();
        }
        const backoff = Math.min(
          RECONNECT_BASE_MS * 2 ** (attempt - 1),
          RECONNECT_MAX_MS
        );
        log.warn("fusor stream errored; reconnecting", {
          error: error instanceof Error ? error.message : String(error),
          backoff,
        });
        // Cancelable sleep: close() clears the timer and resolves it so
        // shutdown doesn't wait out the (up to 30s) backoff.
        await new Promise<void>((resolve) => {
          this.reconnectResolve = resolve;
          const timer = setTimeout(resolve, backoff);
          timer.unref?.();
          this.reconnectTimer = timer;
        });
        this.reconnectTimer = undefined;
        this.reconnectResolve = undefined;
      }
    }
  }

  private async runOnce(): Promise<void> {
    if (!(this.channel && this.tokenProvider)) {
      throw new Error("fusor: channel/token not initialized");
    }
    const token = await this.tokenProvider.getToken();

    const client = createClient(EventsServiceDefinition, this.channel);

    const { iterable: requestIterable, sink } = createRequestSink();
    this.requestSink = sink;

    sink.push({ init: { startSeq: 0 }, reply: undefined });

    // Fusor's gRPC auth (fanout-grpc `authorize()`) reads the raw JWT from the
    // `access_token` metadata key — not an `authorization: Bearer …` header.
    const metadata = Metadata().set("access_token", token);
    const stream = client.subscribe(requestIterable, { metadata });

    try {
      for await (const response of stream) {
        if (this.stopped) {
          break;
        }
        await this.handleEvent(response);
      }
    } finally {
      sink.close();
      this.requestSink = undefined;
    }
  }

  // Transport-independent event processing: route by platform, parse the wire
  // request, run every registered handler (verify → messages), and combine the
  // results into a single InboundReply. Returns the reply instead of writing it
  // anywhere, so both the gRPC stream (sendReply) and the synchronous webhook
  // path can drive it. `deliver` controls where produced records go: the gRPC
  // path defaults to each handler's pushMessage (the per-platform queue feeding
  // spectrum.messages); the webhook path collects them for the request instead.
  async processEvent(
    event: RawInboundEvent,
    deliver?: (record: ProviderMessageRecord) => void
  ): Promise<InboundReply> {
    const handlers = this.handlers.get(event.platform) ?? [];
    if (handlers.length === 0) {
      log.warn("fusor: no handler for platform", { platform: event.platform });
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
      const errorReason =
        error instanceof Error ? error.message : String(error);
      log.warn("fusor: failed to parse raw_request", {
        platform: event.platform,
        error: errorReason,
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

  private async handleEvent(response: SubscribeResponse): Promise<void> {
    const event = response.event;
    if (!event) {
      log.warn("fusor: received SubscribeResponse with no event");
      return;
    }
    const reply = await this.processEvent(event);
    this.sendReply(reply);
  }

  private sendReply(reply: InboundReply): void {
    if (!this.requestSink) {
      return;
    }
    this.requestSink.push({ init: undefined, reply });
  }

  async close(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.requestSink?.close();
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
    this.channel?.close();
    this.stopResolve?.();
  }

  async waitStopped(): Promise<void> {
    return this.stoppedPromise;
  }
}
