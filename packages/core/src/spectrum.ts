import {
  createLogger,
  type OtelHandle,
  setupOtel,
  withSpan,
} from "@photon-ai/otel";
import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import z from "zod";
import { SPECTRUM_BUILD_ENV, SPECTRUM_SDK_VERSION } from "./build-env";
import type { ContentInput } from "./content/types";
import { FusorCore, type RegisteredFusorHandler } from "./fusor/core";
import { isFusorClient } from "./fusor/index";
import type {
  FusorClient,
  FusorMessages,
  WebhookHandler,
  WebhookRawRequest,
  WebhookRawResult,
} from "./fusor/types";
import {
  buildSpace,
  type ProviderMessageRecord,
  wrapProviderMessage,
} from "./platform/build";
import type {
  AnyPlatformDef,
  CustomEventStreams,
  PlatformProviderConfig,
  PlatformRuntime,
  SpectrumLike,
} from "./platform/types";
import type { Message } from "./types/message";
import type { Space } from "./types/space";
import type { AgentSender } from "./types/user";
import { cloud, type ProjectData } from "./utils/cloud";
import {
  normalizePlatformKey,
  officialProviderInstallHint,
} from "./utils/provider-packages";
import { createStore, type Store } from "./utils/store";
import {
  type AsyncQueue,
  type Broadcaster,
  broadcast,
  createAsyncQueue,
  type ManagedStream,
  mergeStreams,
  stream,
} from "./utils/stream";
import { contentAttrs, senderAttrs } from "./utils/telemetry";
import {
  type DeserializeContext,
  deserializeSpectrumMessage,
} from "./webhook/deserialize";
import { type SlimEnvelope, slimEnvelopeSchema } from "./webhook/types";
import { verifySpectrumSignature } from "./webhook/verify";

// Default OTLP endpoint used when `telemetry: true` opts into Photon. Standard
// OTEL_EXPORTER_OTLP_* env vars always override this.
const PHOTON_OTEL_ENDPOINT = "https://otlp.photon.codes";

// Upper bound on the Phase-1 stream cascade during stop(). Well-behaved
// providers cancel via iterator.return() well under this; a misbehaving
// (uncancellable) provider is rescued by destroyClient (Phase 3), and the
// residual stream close is awaited at the very end — so stop() never hangs.
const STREAM_CLOSE_TIMEOUT_MS = 5000;

const lifecycleLog = createLogger("spectrum.lifecycle");

const ignoreCleanupError = () => undefined;

// ---------------------------------------------------------------------------
// SpectrumInstance — the typed return of Spectrum()
// ---------------------------------------------------------------------------

export type SpectrumInstance<
  Providers extends PlatformProviderConfig[] = PlatformProviderConfig[],
> = SpectrumLike<Providers> &
  CustomEventStreams<Providers> & {
    readonly messages: AsyncIterable<[Space, Message]>;
    stop(): Promise<void>;
    send(
      space: Space,
      content: ContentInput
    ): Promise<Message<string, AgentSender> | undefined>;
    send(
      space: Space,
      ...content: [ContentInput, ContentInput, ...ContentInput[]]
    ): Promise<Message<string, AgentSender>[]>;
    edit(message: Message, newContent: ContentInput): Promise<void>;
    responding<T>(space: Space, fn: () => T | Promise<T>): Promise<T>;
    /**
     * Handle one inbound webhook delivery. Call this from your HTTP server's
     * POST route — it auto-detects which of the two Spectrum webhook formats the
     * request carries and routes accordingly:
     *
     * - **Native Spectrum webhook** (the body is normalized JSON): Spectrum Cloud
     *   POSTs already-normalized, HMAC-signed JSON. The signature is verified
     *   against `Spectrum({ webhookSecret })` (a bad signature → 401), the slim
     *   payload is deserialized into `[space, message]`, and a `200` is returned.
     *   Works without any fusor provider configured.
     * - **Fusor webhook** (the body is a protobuf envelope): a protobuf wrapping a
     *   raw provider request is decoded and routed to the matching provider's
     *   verify + message pipeline; the HTTP response is that platform's
     *   `respond()` reply (including protocol echoes like Slack
     *   `url_verification`), computed synchronously and returned immediately.
     *
     * Detection is by payload shape, not headers — Spectrum signs both kinds with
     * `X-Spectrum-Signature`, so the header can't discriminate.
     *
     * `handler` is invoked once per resolved message **fire-and-forget** — it is
     * dispatched after the response is computed and is NOT awaited, so its
     * outcome never changes the response (a throw is logged, not surfaced). On a
     * long-running server the event loop keeps it alive; on serverless/edge,
     * keeping the work alive past the response is the caller's job (e.g. enqueue
     * and process in a separate worker).
     *
     * Stateless and request-scoped: it does NOT feed `spectrum.messages`, and it
     * never opens the streaming connection. Both formats deliver at-least-once,
     * so `handler` should dedupe on `message`/the event id for exactly-once side
     * effects.
     */
    webhook(request: Request, handler: WebhookHandler): Promise<Response>;
    webhook(
      request: WebhookRawRequest,
      handler: WebhookHandler
    ): Promise<WebhookRawResult>;
  };

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

/**
 * Runtime behavior tweaks for a Spectrum instance.
 */
export interface SpectrumOptions {
  /**
   * When `true`, inbound `group` messages are never delivered whole. Instead,
   * each group item is yielded from `spectrum.messages` as its own
   * `[space, message]` tuple, in order. Items retain their individual
   * `id`, `sender`, `timestamp`, and `.react()` / `.reply()` methods.
   *
   * Does not affect outbound `group(...)` sends or `space.getMessage(id)`.
   *
   * @default false
   */
  flattenGroups?: boolean;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const spectrumOptionsSchema = z
  .object({
    flattenGroups: z.boolean().optional(),
  })
  .optional();

const spectrumConfigSchema = z.union([
  z.object({
    projectId: z.string().min(1),
    projectSecret: z.string().min(1),
    providers: z.array(z.custom<PlatformProviderConfig>()),
    options: spectrumOptionsSchema,
    telemetry: z.boolean().optional(),
    webhookSecret: z.string().min(1).optional(),
  }),
  z.object({
    projectId: z.undefined().optional(),
    projectSecret: z.undefined().optional(),
    providers: z.array(z.custom<PlatformProviderConfig>()),
    options: spectrumOptionsSchema,
    telemetry: z.boolean().optional(),
    webhookSecret: z.string().min(1).optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Telemetry bootstrap
// ---------------------------------------------------------------------------

function bootstrapTelemetry(opts: {
  projectId?: string;
  projectSecret?: string;
}): OtelHandle | undefined {
  const headers: Record<string, string> = {};
  if (opts.projectId && opts.projectSecret) {
    const credential = `${opts.projectId}:${opts.projectSecret}`;
    headers.Authorization = `Basic ${btoa(credential)}`;
  }
  const resourceAttributes: Record<string, string> = {
    "deployment.environment": process.env.DEPLOYMENT_ENV ?? SPECTRUM_BUILD_ENV,
  };
  if (opts.projectId) {
    resourceAttributes["spectrum.project_id"] = opts.projectId;
  }
  return setupOtel({
    serviceName: "spectrum-ts",
    serviceVersion: SPECTRUM_SDK_VERSION,
    endpoint: PHOTON_OTEL_ENDPOINT,
    headers,
    resourceAttributes,
  });
}

// ---------------------------------------------------------------------------
// Spectrum() factory
// ---------------------------------------------------------------------------

export async function Spectrum<
  const Providers extends PlatformProviderConfig[],
>(options: {
  projectId: string;
  projectSecret: string;
  providers: [...Providers];
  options?: SpectrumOptions;
  telemetry?: boolean;
  webhookSecret?: string;
}): Promise<SpectrumInstance<Providers> & { readonly config: ProjectData }>;
export async function Spectrum<
  const Providers extends PlatformProviderConfig[],
>(options: {
  projectId?: never;
  projectSecret?: never;
  providers: [...Providers];
  options?: SpectrumOptions;
  telemetry?: boolean;
  webhookSecret?: string;
}): Promise<SpectrumInstance<Providers>>;
export async function Spectrum<
  const Providers extends PlatformProviderConfig[],
>(
  options:
    | {
        projectId: string;
        projectSecret: string;
        providers: [...Providers];
        options?: SpectrumOptions;
        telemetry?: boolean;
        webhookSecret?: string;
      }
    | {
        projectId?: never;
        projectSecret?: never;
        providers: [...Providers];
        options?: SpectrumOptions;
        telemetry?: boolean;
        webhookSecret?: string;
      }
): Promise<SpectrumInstance<Providers>> {
  spectrumConfigSchema.parse(options);

  const {
    projectId,
    projectSecret,
    providers,
    options: runtimeOptions,
    telemetry,
    webhookSecret,
  } = options;
  const flattenGroups = runtimeOptions?.flattenGroups ?? false;
  // The per-webhook signing secret for native Spectrum webhooks. Explicit option
  // wins; otherwise fall back to the env var so deployments can inject it.
  const resolvedWebhookSecret =
    webhookSecret ?? process.env.SPECTRUM_WEBHOOK_SECRET;

  const otelHandle = telemetry
    ? bootstrapTelemetry({ projectId, projectSecret })
    : undefined;

  // Fetch project metadata up-front (before any provider createClient) so that
  // bad credentials fail fast with no half-initialized providers to clean up,
  // and so the resolved config is available to thread into platform `messages`
  // and `events` ctx (e.g. iMessage reads `profile.imessageSynced` from here).
  const projectConfig: ProjectData | undefined =
    projectId !== undefined && projectSecret !== undefined
      ? await cloud.getProject(projectId, projectSecret)
      : undefined;

  const platformStates = new Map<string, PlatformRuntime>();

  // Per-platform fusor message queues (populated only for fusor-mode platforms).
  // When set, the message stream pulls from this queue instead of calling
  // `def.messages({ client, config, store })`.
  const fusorMessageSources = new Map<
    string,
    AsyncQueue<ProviderMessageRecord>
  >();

  // Per-platform message broadcasters (lazy: created on first subscribe).
  const messageBroadcasters = new Map<string, Broadcaster<[Space, Message]>>();

  // Per-(platform, channel) fusor event queues (populated for fusor platforms
  // that declare `events`). Fed by a `messages` handler returning
  // `fusorEvent(channel, data)`; drained as `spectrum.<channel>`.
  const fusorEventSources = new Map<string, Map<string, AsyncQueue<unknown>>>();

  // Per-(platform, channel) event broadcasters (lazy: created on first subscribe).
  const eventBroadcasters = new Map<string, Broadcaster<unknown>>();

  // Custom event streams keyed by event name
  const customEventStreams = new Map<string, ManagedStream<unknown>>();

  let stopped = false;

  // Adapt any AsyncIterable into a ManagedStream, optionally projecting each
  // source value into zero or more output values via `project`. The pump is the
  // only generator layer between the source and the stream, so cleanup's
  // `iterator.return()` reaches the provider's own source directly — for a
  // Repeater-backed ManagedStream or an AsyncQueue that settles immediately,
  // which is what lets `stop()` cancel a parked read instead of deadlocking.
  const adaptIterable = <TIn, TOut = TIn>(
    iterable: AsyncIterable<TIn>,
    project?: (value: TIn, emit: (out: TOut) => Promise<void>) => Promise<void>
  ): ManagedStream<TOut> =>
    stream<TOut>((emit, end) => {
      const iterator = iterable[Symbol.asyncIterator]();

      const pump = (async () => {
        try {
          let result = await iterator.next();
          while (!result.done) {
            if (project) {
              await project(result.value, emit);
            } else {
              await emit(result.value as unknown as TOut);
            }
            result = await iterator.next();
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await iterator.return?.();
        await pump.catch(ignoreCleanupError);
      };
    });

  // Resolve a raw provider record into fully-built [space, message] tuples.
  // Shared by the message stream and the synchronous webhook() path so both
  // produce identical Spaces/Messages (including group flattening).
  const resolveRecordToMessages = async (
    record: ProviderMessageRecord,
    rt: {
      client: unknown;
      config: unknown;
      definition: AnyPlatformDef;
      store: Store;
    }
  ): Promise<[Space, Message][]> => {
    const { client, config, definition, store } = rt;
    const built = await withSpan(
      "spectrum.message.receive",
      {
        "spectrum.provider": definition.name,
        "spectrum.message.id": record.id,
        "spectrum.space.id": record.space?.id,
        ...contentAttrs(record.content),
        ...senderAttrs(record.sender),
      },
      () => {
        const spaceRef = {
          ...record.space,
          __platform: definition.name,
        };
        const actionCtx = { space: spaceRef, client, config, store };
        const space = buildSpace({
          spaceRef,
          extras: {},
          actionCtx,
          definition,
          client,
          config,
          store,
        });
        const normalizedMessage = wrapProviderMessage(
          record,
          {
            client,
            config,
            definition,
            space,
            spaceRef,
            store,
          },
          "inbound"
        );
        return { space, normalizedMessage };
      }
    );
    const { space, normalizedMessage } = built;
    if (flattenGroups && normalizedMessage.content.type === "group") {
      return normalizedMessage.content.items.map((item): [Space, Message] => [
        space,
        item,
      ]);
    }
    return [[space, normalizedMessage]];
  };

  const createProviderMessagesStream = (state: {
    client: unknown;
    config: unknown;
    definition: AnyPlatformDef;
    store: Store;
  }): ManagedStream<[Space, Message]> => {
    const { client, config, definition, store } = state;
    const fusorSource = fusorMessageSources.get(definition.name);
    const raw = fusorSource
      ? fusorSource.iterable
      : (definition.messages({
          client,
          config,
          projectConfig,
          store,
        }) as unknown as AsyncIterable<ProviderMessageRecord>);

    return adaptIterable<ProviderMessageRecord, [Space, Message]>(
      raw,
      async (record, emit) => {
        const tuples = await resolveRecordToMessages(record, {
          client,
          config,
          definition,
          store,
        });
        for (const tuple of tuples) {
          await emit(tuple);
        }
      }
    );
  };

  const getOrCreateMessageBroadcast = (state: {
    client: unknown;
    config: unknown;
    definition: AnyPlatformDef;
    store: Store;
  }): Broadcaster<[Space, Message]> => {
    if (stopped) {
      throw new Error(
        `Spectrum instance has been stopped; cannot subscribe to "${state.definition.name}" messages`
      );
    }
    const name = state.definition.name;
    let broadcaster = messageBroadcasters.get(name);
    if (!broadcaster) {
      broadcaster = broadcast(createProviderMessagesStream(state));
      messageBroadcasters.set(name, broadcaster);
    }
    return broadcaster;
  };

  // Broadcast a fusor platform's per-channel event queue so both the
  // spectrum-level `spectrum.<channel>` stream and the instance-level
  // `platform.<channel>` property can consume it independently. Returns
  // undefined when the platform declared no such channel (every regular
  // platform), so callers fall back to the producer path.
  const getOrCreateEventBroadcast = (
    platform: string,
    channel: string
  ): Broadcaster<unknown> | undefined => {
    const queue = fusorEventSources.get(platform)?.get(channel);
    if (!queue) {
      return;
    }
    if (stopped) {
      throw new Error(
        `Spectrum instance has been stopped; cannot subscribe to "${platform}" event "${channel}"`
      );
    }
    const key = `${platform} ${channel}`;
    let broadcaster = eventBroadcasters.get(key);
    if (!broadcaster) {
      broadcaster = broadcast(adaptIterable(queue.iterable));
      eventBroadcasters.set(key, broadcaster);
    }
    return broadcaster;
  };

  // Initialize all provider clients eagerly. Each runtime exposes
  // `subscribeMessages()` that returns a fresh fanout consumer of the
  // platform's single upstream message stream.
  await withSpan(
    "spectrum.init",
    {
      "spectrum.provider_count": providers.length,
      "spectrum.flatten_groups": flattenGroups,
    },
    async () => {
      for (const provider of providers) {
        const providerConfig = provider as PlatformProviderConfig;
        const def = providerConfig.__definition;
        const userConfig = def.config.parse(providerConfig.config);
        const store = createStore();

        const client = await withSpan(
          "spectrum.provider.create_client",
          {
            "spectrum.provider": def.name,
          },
          () =>
            def.lifecycle.createClient({
              config: userConfig,
              projectId,
              projectSecret,
              projectConfig,
              store,
            })
        );

        const state = {
          client,
          config: userConfig,
          definition: def,
          store,
        };

        platformStates.set(def.name, {
          ...state,
          projectConfig,
          subscribeMessages: () =>
            getOrCreateMessageBroadcast(state).subscribe(),
          // Fanout subscription to a fusor event channel. Returns undefined for
          // regular platforms (no per-channel queue) — callers fall back to the
          // producer path. Resolved lazily, after the fusor bootstrap below has
          // created the per-(platform, channel) queues.
          subscribeEvent: (channel: string) =>
            getOrCreateEventBroadcast(def.name, channel)?.subscribe(),
        });
      }
    }
  );

  // Bootstrap fusor: if any provider's createClient returned a FusorClient,
  // register a handler per platform so both transports can route to it. The
  // gRPC stream is NOT opened here — it starts lazily on the first
  // spectrum.messages subscription (ensureFusorStarted). spectrum.webhook()
  // drives the same handlers synchronously and never opens the stream.
  let fusorCore: FusorCore | undefined;
  let fusorStartPromise: Promise<void> | undefined;
  const fusorPlatforms: { name: string; client: FusorClient }[] = [];
  for (const [name, state] of platformStates) {
    if (isFusorClient(state.client)) {
      fusorPlatforms.push({ name, client: state.client });
    }
  }

  if (fusorPlatforms.length > 0) {
    fusorCore = new FusorCore({ projectId, projectSecret });
    for (const { name, client } of fusorPlatforms) {
      const queue = createAsyncQueue<ProviderMessageRecord>();
      fusorMessageSources.set(name, queue);

      const runtime = platformStates.get(name);
      if (!runtime) {
        continue;
      }
      const userMessages = runtime.definition
        .messages as unknown as FusorMessages<unknown>;

      // One queue per declared event channel (schema-valued `events` keys).
      // `pushEvent` routes a `fusorEvent(channel, data)` here; an undeclared
      // channel (a typo in the handler) is warned and dropped rather than
      // silently lost.
      const declaredEvents = (runtime.definition.events ?? {}) as Record<
        string,
        unknown
      >;
      const eventQueues = new Map<string, AsyncQueue<unknown>>();
      for (const channel of Object.keys(declaredEvents)) {
        eventQueues.set(channel, createAsyncQueue<unknown>());
      }
      fusorEventSources.set(name, eventQueues);

      const handler: RegisteredFusorHandler = {
        verify: client.verify,
        // Enrich the transport-level `{ payload, respond }` ctx with the same
        // runtime context every other platform callback receives, so fusor
        // handlers can read config/store/projectConfig directly instead of
        // smuggling state through the payload.
        messages: async (ctx) =>
          userMessages({
            ...ctx,
            config: runtime.config,
            store: runtime.store,
            projectConfig: runtime.projectConfig,
          }),
        pushMessage: (record) => queue.push(record),
        pushEvent: (channel, data) => {
          const eventQueue = eventQueues.get(channel);
          if (!eventQueue) {
            lifecycleLog.warn(
              `spectrum: fusorEvent("${channel}", …) names a channel not declared in "${name}".events; dropping`,
              { platform: name, channel }
            );
            return;
          }
          eventQueue.push(data);
        },
      };
      fusorCore.register(client.platform, handler);
    }
  }

  // Open the fusor gRPC stream on demand — exactly once, on the first
  // spectrum.messages subscription. Requires cloud credentials (enforced in
  // FusorCore.start). Webhook-only setups never call this, so they never
  // connect and don't need credentials.
  const ensureFusorStarted = (): Promise<void> => {
    if (!fusorCore) {
      return Promise.resolve();
    }
    if (!fusorStartPromise) {
      fusorStartPromise = fusorCore.start();
    }
    return fusorStartPromise;
  };

  const providerNames = providers
    .map((p) => (p as PlatformProviderConfig).__definition.name)
    .join(",");

  lifecycleLog.info("Spectrum started", {
    providerCount: providers.length,
    providers: providerNames,
    telemetry: telemetry === true,
  });

  // Advisory, fire-and-forget: in cloud mode, compare the project's enabled
  // platforms against the registered providers and hint at any missing
  // optional provider package. Never blocks or fails startup — the platforms
  // endpoint is best-effort diagnostics only.
  if (projectConfig && projectId !== undefined) {
    const registered = new Set(
      Array.from(platformStates.keys(), normalizePlatformKey)
    );
    cloud
      .getPlatforms(projectId)
      .then((platforms) => {
        for (const [platform, status] of Object.entries(platforms)) {
          if (
            !status.enabled ||
            registered.has(normalizePlatformKey(platform))
          ) {
            continue;
          }
          const hint = officialProviderInstallHint(platform);
          lifecycleLog.warn(
            hint
              ? `spectrum: project has "${platform}" enabled but no matching provider is registered — ${hint}`
              : `spectrum: project has "${platform}" enabled but no matching provider is registered`,
            { platform }
          );
        }
      })
      .catch(() => {
        // Diagnostics only — ignore network failures.
      });
  }

  const createMessagesStream = (): ManagedStream<[Space, Message]> =>
    stream<[Space, Message]>((emit, end) => {
      // Open the fusor gRPC stream lazily on first subscription. A fatal connect
      // failure (e.g. missing credentials) surfaces on this iterator. Non-async
      // so subscribe stays non-blocking. Webhook-only setups never reach here.
      ensureFusorStarted().catch((error) => end(error));
      const merged = mergeStreams(
        Array.from(platformStates.values(), (runtime) =>
          runtime.subscribeMessages()
        )
      );

      const pump = (async () => {
        try {
          for await (const value of merged) {
            await emit(value);
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await merged.close();
        await pump.catch(ignoreCleanupError);
      };
    });

  const createCustomEventStream = (eventName: string): ManagedStream<unknown> =>
    stream<unknown>((emit, end) => {
      const providerStreams: ManagedStream<unknown>[] = [];
      for (const state of platformStates.values()) {
        const { client, config, definition, store } = state;

        // Resolve this platform's raw source for `eventName`: a fusor platform's
        // per-channel fanout (declared as a schema, fed by `fusorEvent(...)`) or
        // a regular platform's producer. Skip platforms that have neither.
        let source: AsyncIterable<unknown> | undefined =
          state.subscribeEvent?.(eventName);
        if (!source) {
          const producer = definition.events?.[eventName];
          if (typeof producer !== "function") {
            continue;
          }
          source = (
            producer as (ctx: {
              client: unknown;
              config: unknown;
              projectConfig: ProjectData | undefined;
              store: Store;
            }) => AsyncIterable<unknown>
          )({ client, config, projectConfig, store });
        }

        const providerEvents = source;
        providerStreams.push(
          adaptIterable<unknown, unknown>(
            providerEvents,
            async (value, emit) => {
              const annotated = await withSpan(
                "spectrum.event",
                {
                  "spectrum.provider": definition.name,
                  "spectrum.event.name": eventName,
                },
                // Object payloads are flattened and tagged with `platform`. A
                // primitive/null payload can't be spread (a string would mangle
                // into indexed chars, a number/bool would vanish), so wrap it
                // under `payload` instead.
                () =>
                  typeof value === "object" && value !== null
                    ? { ...value, platform: definition.name }
                    : { platform: definition.name, payload: value }
              );
              await emit(annotated);
            }
          )
        );
      }

      const merged = mergeStreams(providerStreams);

      const pump = (async () => {
        try {
          for await (const value of merged) {
            await emit(value);
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await merged.close();
        await pump.catch(ignoreCleanupError);
      };
    });

  const messagesStream = createMessagesStream();

  // Close + drop every fusor queue (per-platform message queues and
  // per-(platform, channel) event queues). Extracted from stopOnce to keep its
  // cognitive complexity in check.
  const closeFusorSources = () => {
    for (const queue of fusorMessageSources.values()) {
      queue.close();
    }
    fusorMessageSources.clear();
    for (const queues of fusorEventSources.values()) {
      for (const queue of queues.values()) {
        queue.close();
      }
    }
    fusorEventSources.clear();
  };

  const stopOnce = async () => {
    if (stopped) {
      return;
    }
    stopped = true;

    const streamShutdowns = [
      messagesStream.close(),
      ...Array.from(customEventStreams.values(), (eventStream) =>
        eventStream.close()
      ),
      ...Array.from(messageBroadcasters.values(), (broadcaster) =>
        broadcaster.close()
      ),
      ...Array.from(eventBroadcasters.values(), (broadcaster) =>
        broadcaster.close()
      ),
    ];

    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);

    // Phase 1: stream cascade (bounded). Start the close, but don't let a
    // misbehaving provider whose stream can't be cancelled block teardown
    // forever — after a timeout, proceed to fusor close + destroyClient (which
    // can unblock such a stream from below), then await the residual at the end.
    const streamCloseStart = performance.now();
    const streamSettled = Promise.allSettled(streamShutdowns);
    let streamTimedOut = false;
    await Promise.race([
      streamSettled,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          streamTimedOut = true;
          resolve();
        }, STREAM_CLOSE_TIMEOUT_MS).unref();
      }),
    ]);
    if (streamTimedOut) {
      lifecycleLog.warn("stream close timed out; proceeding to teardown", {
        timeoutMs: STREAM_CLOSE_TIMEOUT_MS,
      });
    }

    // Phase 2: fusor core shutdown (only when active)
    let fusorCloseMs = 0;
    if (fusorCore) {
      const fusorCloseStart = performance.now();
      // If a lazy gRPC start is in flight, let it finish wiring before teardown
      // so close() doesn't race a half-built connection.
      if (fusorStartPromise) {
        await fusorStartPromise.catch(ignoreCleanupError);
      }
      await fusorCore.close().catch((error) => {
        lifecycleLog.warn("fusor core close failed", { error });
      });
      fusorCloseMs = Math.round(performance.now() - fusorCloseStart);
      closeFusorSources();
    }

    // Phase 3: destroy clients
    const clientShutdowns: Promise<void>[] = [];
    for (const state of platformStates.values()) {
      const destroy = state.definition.lifecycle.destroyClient;
      if (!destroy) {
        continue;
      }
      clientShutdowns.push(
        withSpan(
          "spectrum.provider.destroy_client",
          {
            "spectrum.provider": state.definition.name,
          },
          () =>
            destroy({
              client: state.client,
              store: state.store,
            })
        )
      );
    }
    const clientCloseStart = performance.now();
    await Promise.allSettled(clientShutdowns);
    const clientCloseMs = Math.round(performance.now() - clientCloseStart);

    // Any stream rescued by destroyClient (Phase 3) drains now — ensure it has
    // fully settled before we report stopped and clear the maps.
    await streamSettled.catch(() => undefined);
    const streamCloseMs = Math.round(performance.now() - streamCloseStart);

    customEventStreams.clear();
    messageBroadcasters.clear();
    eventBroadcasters.clear();
    platformStates.clear();
    lifecycleLog.info("Spectrum stopped", {
      providers: providerNames,
      streamCloseMs,
      fusorCloseMs,
      clientCloseMs,
    });
    if (otelHandle) {
      await otelHandle.shutdown();
    }
  };

  const handleSignal = () => {
    setTimeout(() => process.exit(1), 3000).unref();
    stopOnce()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const messages: AsyncIterable<[Space, Message]> = messagesStream;

  // Proxy for flat custom event access (app.typing, app.readReceipt, etc.)
  const customEventProxy = new Proxy(
    {} as Record<string, AsyncIterable<unknown>>,
    {
      get(_target, prop: string) {
        let eventStream = customEventStreams.get(prop);
        if (!eventStream) {
          eventStream = createCustomEventStream(prop);
          customEventStreams.set(prop, eventStream);
        }
        return eventStream;
      },
    }
  );

  const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);

  // Build either a Web `Response` (when the caller passed a `Request`) or the
  // raw `{ status, headers, body }` shape (Express/raw Node).
  const buildWebhookResult = (
    asWeb: boolean,
    result: WebhookRawResult
  ): Response | WebhookRawResult => {
    if (asWeb) {
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    }
    return result;
  };

  // Read the RAW request bytes without re-encoding — both the protobuf decode
  // (fusor) and the HMAC verification (native) need the exact bytes received.
  // `asWeb` records whether to reply with a Web `Response` or the raw result
  // shape; `headers` (keys lowercased) carry the native webhook's signature.
  const readWebhookInput = async (
    request: Request | WebhookRawRequest
  ): Promise<{
    asWeb: boolean;
    bodyBytes: Uint8Array;
    headers: Record<string, string>;
  }> => {
    if (typeof Request !== "undefined" && request instanceof Request) {
      const headers: Record<string, string> = {};
      for (const [key, value] of request.headers) {
        headers[key.toLowerCase()] = value;
      }
      return {
        asWeb: true,
        bodyBytes: new Uint8Array(await request.arrayBuffer()),
        headers,
      };
    }
    // The compound `typeof Request` guard above doesn't narrow the union here.
    const raw = request as WebhookRawRequest;
    const bodyBytes =
      raw.body instanceof ArrayBuffer ? new Uint8Array(raw.body) : raw.body;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    return { asWeb: false, bodyBytes, headers };
  };

  // Resolve each collected record and hand it to the request-scoped handler.
  // Each handler invocation is isolated: a throw on one message is logged with
  // its own context and does NOT skip the remaining messages in the batch.
  const deliverWebhookMessages = async (
    collected: ProviderMessageRecord[],
    runtime: PlatformRuntime,
    handler: WebhookHandler,
    context: { eventId?: string; platform: string }
  ): Promise<void> => {
    for (const record of collected) {
      const tuples = await resolveRecordToMessages(record, runtime);
      for (const [space, message] of tuples) {
        try {
          await handler(space, message);
        } catch (error) {
          lifecycleLog.error(
            `spectrum.webhook: handler threw (async), ${error}`,
            {
              eventId: context.eventId,
              platform: context.platform,
              messageId: message.id,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }
    }
  };

  // Decode the protobuf envelope; null = undecodable (poison → 400).
  const decodeWebhookEvent = (
    bodyBytes: Uint8Array
  ): RawInboundEvent | null => {
    try {
      return RawInboundEvent.decode(bodyBytes);
    } catch (error) {
      lifecycleLog.warn("spectrum.webhook: undecodable RawInboundEvent body", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // Run the shared fusor pipeline for a decoded event and map it to an HTTP
  // result. Records are collected for THIS request (webhook is stateless — they
  // do not feed spectrum.messages).
  const processWebhookEvent = async (
    core: FusorCore,
    event: RawInboundEvent,
    handler: WebhookHandler
  ): Promise<WebhookRawResult> => {
    const collected: ProviderMessageRecord[] = [];
    const reply = await core.processEvent(event, (record) => {
      collected.push(record);
    });

    // A verify/parse/no-handler failure is poison — 400 (a retry won't help).
    if (reply.errorReason) {
      return {
        status: 400,
        headers: reply.headers ?? {},
        body: encodeText(reply.errorReason),
      };
    }

    // The HTTP response is the platform's respond() reply (status 0 → 200,
    // carrying protocol echoes like Slack url_verification). It is owned entirely
    // by the pipeline — the handler dispatched below never affects it.
    const result: WebhookRawResult = {
      status: reply.status === 0 ? 200 : reply.status,
      headers: reply.headers ?? {},
      body: reply.body ?? new Uint8Array(0),
    };

    // Deliver to the request-scoped handler fire-and-forget: dispatched after
    // the response is computed and NOT awaited, mirroring a
    // `for await (… of spectrum.messages)` loop body. A throw is caught + logged,
    // never surfaced as a 500 / fusor retry. On a long-running server the event
    // loop keeps this alive; on serverless, keeping it alive past the response is
    // the caller's responsibility (e.g. enqueue + process in a separate worker).
    const runtime = platformStates.get(event.platform);
    if (runtime && collected.length > 0) {
      // Per-message handler throws are isolated + logged inside
      // deliverWebhookMessages; this safety net only fires on a message
      // resolution or otherwise unexpected error.
      deliverWebhookMessages(collected, runtime, handler, event).catch(
        (error) => {
          lifecycleLog.error(
            `spectrum.webhook: delivery failed (async), ${error}`,
            {
              eventId: event.eventId,
              platform: event.platform,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      );
    }

    return result;
  };

  // --- Native Spectrum webhook (signed, normalized JSON) -------------------

  // Distinguish a native Spectrum webhook from a fusor one by the PAYLOAD, not a
  // header: Spectrum signs both kinds with `x-spectrum-signature`, so the header
  // can't tell them apart. A native body is a JSON object (`{…`); a fusor body is
  // a binary protobuf `RawInboundEvent`, which never starts with `{`.
  const looksLikeNativePayload = (bodyBytes: Uint8Array): boolean => {
    for (const byte of bodyBytes) {
      // Skip leading ASCII whitespace (space, tab, LF, CR).
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
        continue;
      }
      return byte === 0x7b; // "{"
    }
    return false;
  };

  const webhookText = (status: number, text: string): WebhookRawResult => ({
    status,
    headers: {},
    body: encodeText(text),
  });

  // A platform's optional attachment-fetch capability (e.g. iMessage's
  // `getAttachment`). Used to lazily back a native webhook attachment's
  // read()/stream(), since the webhook delivers metadata only.
  type GetAttachmentAction = (
    ctx: { client: unknown; config: unknown; store: Store },
    attachmentId: string,
    phone?: string
  ) => Promise<
    | {
        read: () => Promise<Buffer>;
        stream?: () => Promise<ReadableStream<Uint8Array>>;
      }
    | undefined
  >;

  const resolveWebhookAttachment: DeserializeContext["resolveAttachment"] = (
    platform,
    spaceRef,
    attachmentId
  ) => {
    const runtime = platformStates.get(platform);
    const action = (
      runtime?.definition as { actions?: Record<string, unknown> } | undefined
    )?.actions?.getAttachment;
    if (!runtime || typeof action !== "function") {
      return;
    }
    const getAttachment = action as GetAttachmentAction;
    const phone =
      typeof spaceRef.phone === "string" ? spaceRef.phone : undefined;
    let cached: ReturnType<GetAttachmentAction> | undefined;
    const fetchOnce = (): ReturnType<GetAttachmentAction> => {
      cached ??= getAttachment(
        {
          client: runtime.client,
          config: runtime.config,
          store: runtime.store,
        },
        attachmentId,
        phone
      );
      return cached;
    };
    return {
      read: async () => {
        const found = await fetchOnce();
        if (!found) {
          throw new Error(
            `Spectrum webhook attachment "${attachmentId}" not found on "${platform}"`
          );
        }
        return found.read();
      },
      stream: async () => {
        const found = await fetchOnce();
        if (!found?.stream) {
          throw new Error(
            `Spectrum webhook attachment "${attachmentId}" has no stream on "${platform}"`
          );
        }
        return found.stream();
      },
    };
  };

  // Verify the HMAC signature, deserialize the slim JSON into a [space, message],
  // and deliver fire-and-forget (mirroring the fusor path). Verification runs
  // BEFORE any parse/dispatch, so a forged body is rejected (401) without ever
  // reaching the handler.
  const handleSpectrumWebhook = async (
    bodyBytes: Uint8Array,
    headers: Record<string, string>,
    handler: WebhookHandler
  ): Promise<WebhookRawResult> => {
    if (!resolvedWebhookSecret) {
      lifecycleLog.error(
        "spectrum.webhook: received a signed Spectrum webhook but no webhookSecret is configured (set Spectrum({ webhookSecret }) or SPECTRUM_WEBHOOK_SECRET)"
      );
      return webhookText(500, "webhook secret not configured");
    }

    const verification = verifySpectrumSignature({
      rawBody: bodyBytes,
      headers,
      secret: resolvedWebhookSecret,
    });
    if (!verification.ok) {
      // Bad signature / expired timestamp → unauthenticated (401); a missing
      // signature header → malformed (400). Neither is retryable.
      const status = verification.reason === "missing-headers" ? 400 : 401;
      return webhookText(status, verification.reason);
    }

    let envelope: SlimEnvelope;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
      envelope = slimEnvelopeSchema.parse(parsed);
    } catch (error) {
      lifecycleLog.warn(
        `spectrum.webhook: malformed Spectrum webhook payload, ${error}`
      );
      return webhookText(400, "malformed payload");
    }

    const deserialized = deserializeSpectrumMessage(envelope, {
      resolveAttachment: resolveWebhookAttachment,
    });
    if (!deserialized) {
      // Unknown event type or unroutable message — acknowledge so Spectrum does
      // not retry (neither is fixed by retrying).
      return webhookText(200, "ok");
    }

    const { platform, record } = deserialized;
    const runtime = platformStates.get(platform);
    if (!runtime) {
      lifecycleLog.warn(
        `spectrum.webhook: no provider configured for platform "${platform}"; acknowledging without delivery`,
        { platform }
      );
      return webhookText(200, "ok");
    }

    // Fire-and-forget, mirroring the fusor path: acknowledge now, deliver after.
    deliverWebhookMessages([record], runtime, handler, { platform }).catch(
      (error) => {
        lifecycleLog.error(
          `spectrum.webhook: Spectrum delivery failed (async), ${error}`,
          {
            platform,
            messageId: record.id,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    );
    return webhookText(200, "ok");
  };

  const handleWebhook = async (
    request: Request | WebhookRawRequest,
    handler: WebhookHandler
  ): Promise<Response | WebhookRawResult> => {
    const { asWeb, bodyBytes, headers } = await readWebhookInput(request);

    // Route by payload shape: a native webhook is JSON, a fusor one is protobuf.
    // Both may carry an `x-spectrum-signature` header, so it can't discriminate.
    if (looksLikeNativePayload(bodyBytes)) {
      const spectrumResult = await handleSpectrumWebhook(
        bodyBytes,
        headers,
        handler
      );
      return buildWebhookResult(asWeb, spectrumResult);
    }

    if (!fusorCore) {
      throw new Error(
        "spectrum.webhook() received a non-Spectrum (fusor) request but no fusor provider is configured"
      );
    }

    const event = decodeWebhookEvent(bodyBytes);
    if (!event) {
      return buildWebhookResult(asWeb, {
        status: 400,
        headers: {},
        body: new Uint8Array(0),
      });
    }

    const result = await processWebhookEvent(fusorCore, event, handler);
    return buildWebhookResult(asWeb, result);
  };

  const base = {
    __providers: providers,
    __internal: { platforms: platformStates },
    config: projectConfig,
    messages,
    stop: stopOnce,
    webhook: handleWebhook as SpectrumInstance["webhook"],
    send: (async (
      space: Space,
      ...content: [ContentInput, ...ContentInput[]]
    ): Promise<
      Message<string, AgentSender> | Message<string, AgentSender>[] | undefined
    > =>
      content.length === 1
        ? await space.send(content[0])
        : await space.send(
            ...(content as [ContentInput, ContentInput, ...ContentInput[]])
          )) as SpectrumInstance["send"],
    edit: async (message: Message, newContent: ContentInput) => {
      await message.edit(newContent);
    },
    responding: async <T>(space: Space, fn: () => T | Promise<T>): Promise<T> =>
      space.responding(fn),
  };

  // Merge base instance with custom event proxy
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === "string") {
        return customEventProxy[prop];
      }
      return;
    },
  }) as SpectrumInstance<Providers>;
}
