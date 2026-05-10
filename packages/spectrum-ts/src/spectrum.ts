import z from "zod";
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
import type { InboundMessage, OutboundMessage } from "./types/message";
import type { Space } from "./types/space";
import { createStore, type Store } from "./utils/store";
import {
  type Broadcaster,
  broadcast,
  type ManagedStream,
  mergeStreams,
  stream,
} from "./utils/stream";

const ignoreCleanupError = () => undefined;

// ---------------------------------------------------------------------------
// SpectrumInstance — the typed return of Spectrum()
// ---------------------------------------------------------------------------

export type SpectrumInstance<
  Providers extends PlatformProviderConfig[] = PlatformProviderConfig[],
> = SpectrumLike<Providers> &
  CustomEventStreams<Providers> & {
    readonly messages: AsyncIterable<[Space, InboundMessage]>;
    stop(): Promise<void>;
    send(
      space: Space,
      content: ContentInput
    ): Promise<OutboundMessage | undefined>;
    send(
      space: Space,
      ...content: [ContentInput, ContentInput, ...ContentInput[]]
    ): Promise<OutboundMessage[]>;
    edit(message: OutboundMessage, newContent: ContentInput): Promise<void>;
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
  }),
  z.object({
    projectId: z.undefined().optional(),
    projectSecret: z.undefined().optional(),
    providers: z.array(z.custom<PlatformProviderConfig>()),
    options: spectrumOptionsSchema,
  }),
]);

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
      }
    | {
        projectId?: never;
        projectSecret?: never;
        providers: [...Providers];
        options?: SpectrumOptions;
      }
): Promise<SpectrumInstance<Providers>> {
  spectrumConfigSchema.parse(options);

  const {
    projectId,
    projectSecret,
    providers,
    options: runtimeOptions,
  } = options;
  const flattenGroups = runtimeOptions?.flattenGroups ?? false;

  const platformStates = new Map<string, PlatformRuntime>();

  // Per-platform message broadcasters (lazy: created on first subscribe).
  const messageBroadcasters = new Map<
    string,
    Broadcaster<[Space, InboundMessage]>
  >();

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
  }): ManagedStream<[Space, InboundMessage]> => {
    const { client, config, definition, store } = state;
    const raw = definition.events.messages({
      client,
      config,
      store,
    }) as AsyncIterable<ProviderMessageRecord>;

    const bindSend = async function* (): AsyncIterable<
      [Space, InboundMessage]
    > {
      for await (const msg of raw) {
        const spaceRef = {
          ...msg.space,
          __platform: definition.name,
        };
        const typingCtx = { space: spaceRef, client, config, store };
        const space = buildSpace({
          spaceRef,
          extras: {},
          typingCtx,
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
        if (flattenGroups && normalizedMessage.content.type === "group") {
          for (const item of normalizedMessage.content.items) {
            // Group items in the inbound flow are wrapped via wrapProviderMessage,
            // which always produces InboundMessages — Group.items is just the
            // wider Message type at the schema level.
            yield [space, item as InboundMessage];
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
  }): Broadcaster<[Space, InboundMessage]> => {
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
  for (const provider of providers) {
    const providerConfig = provider as PlatformProviderConfig;
    const def = providerConfig.__definition;
    const userConfig = def.config.parse(providerConfig.config);
    const store = createStore();

    const client = await def.lifecycle.createClient({
      config: userConfig,
      projectId,
      projectSecret,
      store,
    });

    const state = {
      client,
      config: userConfig,
      definition: def,
      store,
    };

    platformStates.set(def.name, {
      ...state,
      subscribeMessages: () => getOrCreateMessageBroadcast(state).subscribe(),
    });
  }

  const createMessagesStream = (): ManagedStream<[Space, InboundMessage]> =>
    stream<[Space, InboundMessage]>((emit, end) => {
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
        const producer = definition.events[eventName] as
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
            yield { ...(value as object), platform: definition.name };
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
    const clientShutdowns = Array.from(platformStates.values(), (state) =>
      state.definition.lifecycle.destroyClient?.({
        client: state.client,
        store: state.store,
      })
    ).filter((shutdown): shutdown is Promise<void> => shutdown !== undefined);
    await Promise.allSettled(clientShutdowns);
    customEventStreams.clear();
    messageBroadcasters.clear();
    platformStates.clear();
  };

  const handleSignal = () => {
    setTimeout(() => process.exit(1), 3000).unref();
    stopOnce()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const messages: AsyncIterable<[Space, InboundMessage]> = messagesStream;

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
    ): Promise<OutboundMessage | OutboundMessage[] | undefined> =>
      content.length === 1
        ? await space.send(content[0])
        : await space.send(
            ...(content as [ContentInput, ContentInput, ...ContentInput[]])
          )) as SpectrumInstance["send"],
    edit: async (message: OutboundMessage, newContent: ContentInput) => {
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
