import {
  createLogger,
  type OtelHandle,
  setupOtel,
  withSpan,
} from "@photon-ai/otel";
import z from "zod";
import { SPECTRUM_BUILD_ENV, SPECTRUM_SDK_VERSION } from "./build-env";
import type { ContentInput } from "./content/types";
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
import { createStore, type Store } from "./utils/store";
import {
  type Broadcaster,
  broadcast,
  type ManagedStream,
  mergeStreams,
  stream,
} from "./utils/stream";
import { contentAttrs, senderAttrs } from "./utils/telemetry";

// Default OTLP endpoint used when `telemetry: true` opts into Photon. Standard
// OTEL_EXPORTER_OTLP_* env vars always override this.
const PHOTON_OTEL_ENDPOINT = "https://otlp.photon.codes";

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
  }),
  z.object({
    projectId: z.undefined().optional(),
    projectSecret: z.undefined().optional(),
    providers: z.array(z.custom<PlatformProviderConfig>()),
    options: spectrumOptionsSchema,
    telemetry: z.boolean().optional(),
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
>(
  options:
    | {
        projectId: string;
        projectSecret: string;
        providers: [...Providers];
        options?: SpectrumOptions;
        telemetry?: boolean;
      }
    | {
        projectId?: never;
        projectSecret?: never;
        providers: [...Providers];
        options?: SpectrumOptions;
        telemetry?: boolean;
      }
): Promise<SpectrumInstance<Providers>> {
  spectrumConfigSchema.parse(options);

  const {
    projectId,
    projectSecret,
    providers,
    options: runtimeOptions,
    telemetry,
  } = options;
  const flattenGroups = runtimeOptions?.flattenGroups ?? false;

  const otelHandle = telemetry
    ? bootstrapTelemetry({ projectId, projectSecret })
    : undefined;

  const platformStates = new Map<string, PlatformRuntime>();

  // Per-platform message broadcasters (lazy: created on first subscribe).
  const messageBroadcasters = new Map<string, Broadcaster<[Space, Message]>>();

  // Custom event streams keyed by event name
  const customEventStreams = new Map<string, ManagedStream<unknown>>();

  let stopped = false;

  const adaptIterable = <T>(iterable: AsyncIterable<T>): ManagedStream<T> =>
    stream<T>((emit, end) => {
      const iterator = iterable[Symbol.asyncIterator]();

      const pump = (async () => {
        try {
          let result = await iterator.next();
          while (!result.done) {
            await emit(result.value);
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

  const createProviderMessagesStream = (state: {
    client: unknown;
    config: unknown;
    definition: AnyPlatformDef;
    store: Store;
  }): ManagedStream<[Space, Message]> => {
    const { client, config, definition, store } = state;
    const raw = definition.messages({
      client,
      config,
      store,
    }) as AsyncIterable<ProviderMessageRecord>;

    const bindSend = async function* (): AsyncIterable<[Space, Message]> {
      for await (const msg of raw) {
        const built = await withSpan(
          "spectrum.message.receive",
          {
            "spectrum.provider": definition.name,
            "spectrum.message.id": msg.id,
            "spectrum.space.id": msg.space?.id,
            ...contentAttrs(msg.content),
            ...senderAttrs(msg.sender),
          },
          () => {
            const spaceRef = {
              ...msg.space,
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
              msg,
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
          for (const item of normalizedMessage.content.items) {
            yield [space, item];
          }
          continue;
        }
        yield [space, normalizedMessage];
      }
    };

    return adaptIterable(bindSend());
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
          subscribeMessages: () =>
            getOrCreateMessageBroadcast(state).subscribe(),
        });
      }
    }
  );

  const providerNames = providers
    .map((p) => (p as PlatformProviderConfig).__definition.name)
    .join(",");

  lifecycleLog.info("Spectrum started", {
    providerCount: providers.length,
    providers: providerNames,
    telemetry: telemetry === true,
  });

  const createMessagesStream = (): ManagedStream<[Space, Message]> =>
    stream<[Space, Message]>((emit, end) => {
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
        const producer = definition.events?.[eventName] as
          | ((ctx: {
              client: unknown;
              config: unknown;
              store: Store;
            }) => AsyncIterable<unknown>)
          | undefined;
        if (!producer) {
          continue;
        }

        const providerEvents = producer({ client, config, store });
        const annotatePlatform = async function* (): AsyncIterable<unknown> {
          for await (const value of providerEvents) {
            const annotated = await withSpan(
              "spectrum.event",
              {
                "spectrum.provider": definition.name,
                "spectrum.event.name": eventName,
              },
              () => ({ ...(value as object), platform: definition.name })
            );
            yield annotated;
          }
        };

        providerStreams.push(adaptIterable(annotatePlatform()));
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
    ];

    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);

    await Promise.allSettled(streamShutdowns);
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
    await Promise.allSettled(clientShutdowns);
    customEventStreams.clear();
    messageBroadcasters.clear();
    platformStates.clear();
    lifecycleLog.info("Spectrum stopped", { providers: providerNames });
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

  const base = {
    __providers: providers,
    __internal: { platforms: platformStates },
    messages,
    stop: stopOnce,
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
