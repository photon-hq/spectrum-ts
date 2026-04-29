import z from "zod";
import type { ContentInput } from "./content/types";
import {
  buildSpace,
  type ProviderMessageRecord,
  wrapProviderMessage,
} from "./platform/build";
import type {
  AnyPlatformDef,
  PlatformProviderConfig,
  PlatformRuntime,
  ProviderEventRecord,
  SpectrumLike,
} from "./platform/types";
import type { InboundMessage, OutboundMessage } from "./types/message";
import type { Space } from "./types/space";
import {
  type Broadcaster,
  broadcast,
  type ManagedStream,
  mergeStreams,
  stream,
} from "./utils/stream";

// ---------------------------------------------------------------------------
// SpectrumInstance — the typed return of Spectrum()
// ---------------------------------------------------------------------------

export type SpectrumInstance<
  Providers extends PlatformProviderConfig[] = PlatformProviderConfig[],
> = SpectrumLike<Providers> & {
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

const MESSAGES_EVENT = "messages";

const stripSpace = (record: ProviderEventRecord): Record<string, unknown> => {
  const { space: _space, ...rest } = record;
  return rest;
};

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

  // One broadcaster per (platform, eventName). Lazy: created on first
  // subscribe so the upstream SDK subscription only runs when something
  // consumes the stream.
  const eventBroadcasters = new Map<string, Broadcaster<[Space, unknown]>>();

  let stopped = false;

  const adaptIterable = <T>(iterable: AsyncIterable<T>): ManagedStream<T> => {
    return stream<T>((emit, end) => {
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
        await pump;
      };
    });
  };

  /**
   * Wrap a single provider's `events[eventName]` stream into a
   * `[Space, payload]` tuple stream. The `messages` event additionally runs
   * `wrapProviderMessage` to attach `.reply()` / `.react()` and to flatten
   * groups when `flattenGroups` is set; every other event yields the raw
   * record minus its `space` field.
   *
   * Returns `undefined` when the platform doesn't define `eventName`, so
   * downstream consumers (the messages merge and platform-level event
   * accessors) can simply skip it.
   */
  const createProviderEventStream = (
    state: {
      client: unknown;
      config: unknown;
      definition: AnyPlatformDef;
    },
    eventName: string
  ): ManagedStream<[Space, unknown]> | undefined => {
    const { client, config, definition } = state;
    const producer = definition.events[eventName] as
      | ((ctx: {
          client: unknown;
          config: unknown;
        }) => AsyncIterable<ProviderEventRecord>)
      | undefined;
    if (!producer) {
      return;
    }

    const raw = producer({ client, config });
    const isMessages = eventName === MESSAGES_EVENT;

    const project = async function* (): AsyncIterable<[Space, unknown]> {
      for await (const record of raw) {
        const spaceRef = {
          ...record.space,
          __platform: definition.name,
        };
        const typingCtx = { space: spaceRef, client, config };
        const space = buildSpace({
          spaceRef,
          extras: {},
          typingCtx,
          definition,
          client,
          config,
        });

        if (isMessages) {
          const wrapped = wrapProviderMessage(
            record as ProviderMessageRecord,
            { client, config, definition, space, spaceRef },
            "inbound"
          );
          if (flattenGroups && wrapped.content.type === "group") {
            for (const item of wrapped.content.items) {
              yield [space, item as InboundMessage];
            }
            continue;
          }
          yield [space, wrapped];
          continue;
        }

        yield [space, stripSpace(record)];
      }
    };

    return adaptIterable(project());
  };

  const getOrCreateEventBroadcast = (
    state: {
      client: unknown;
      config: unknown;
      definition: AnyPlatformDef;
    },
    eventName: string
  ): Broadcaster<[Space, unknown]> | undefined => {
    if (stopped) {
      throw new Error(
        `Spectrum instance has been stopped; cannot subscribe to "${state.definition.name}" event "${eventName}"`
      );
    }
    const key = `${state.definition.name}:${eventName}`;
    let broadcaster = eventBroadcasters.get(key);
    if (broadcaster) {
      return broadcaster;
    }
    const source = createProviderEventStream(state, eventName);
    if (!source) {
      return;
    }
    broadcaster = broadcast(source);
    eventBroadcasters.set(key, broadcaster);
    return broadcaster;
  };

  // Initialize all provider clients eagerly. Each runtime exposes
  // `subscribeEvent(name)` so per-platform and spectrum-level consumers
  // share one broadcaster per (platform, event).
  for (const provider of providers) {
    const providerConfig = provider as PlatformProviderConfig;
    const def = providerConfig.__definition;
    const userConfig = def.config.parse(providerConfig.config);

    const client = await def.lifecycle.createClient({
      config: userConfig,
      projectId,
      projectSecret,
    });

    const state = {
      client,
      config: userConfig,
      definition: def,
    };

    platformStates.set(def.name, {
      ...state,
      subscribeEvent: (eventName) =>
        getOrCreateEventBroadcast(state, eventName)?.subscribe(),
    });
  }

  /**
   * Merge every platform's `messages` stream into one. No per-tuple
   * annotation is added — `InboundMessage` already carries `.platform`.
   * Non-`messages` events are only consumable through the platform-specific
   * accessor (e.g. `imessage(app).typing`); they never fan in here.
   */
  const messagesStream: ManagedStream<[Space, InboundMessage]> = stream<
    [Space, InboundMessage]
  >((emit, end) => {
    const perPlatform = Array.from(platformStates.values(), (runtime) =>
      runtime.subscribeEvent(MESSAGES_EVENT)
    ).filter(
      (value): value is ManagedStream<[Space, unknown]> => value !== undefined
    ) as ManagedStream<[Space, InboundMessage]>[];

    const merged = mergeStreams(perPlatform);

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
      await pump;
    };
  });

  const stopOnce = async () => {
    if (stopped) {
      return;
    }
    stopped = true;

    const streamShutdowns = [
      messagesStream.close(),
      ...Array.from(eventBroadcasters.values(), (broadcaster) =>
        broadcaster.close()
      ),
    ];

    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);

    await Promise.allSettled(streamShutdowns);
    const clientShutdowns = Array.from(platformStates.values(), (state) =>
      state.definition.lifecycle.destroyClient({
        client: state.client,
      })
    );
    await Promise.allSettled(clientShutdowns);
    eventBroadcasters.clear();
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

  return {
    __providers: providers,
    __internal: { platforms: platformStates },
    messages,
    stop: stopOnce,
    send: (async (
      space: Space,
      ...content: [ContentInput, ...ContentInput[]]
    ): Promise<OutboundMessage | OutboundMessage[] | undefined> => {
      return content.length === 1
        ? await space.send(content[0])
        : await space.send(
            ...(content as [ContentInput, ContentInput, ...ContentInput[]])
          );
    }) as SpectrumInstance["send"],
    edit: async (message: OutboundMessage, newContent: ContentInput) => {
      await message.edit(newContent);
    },
    responding: async <T>(
      space: Space,
      fn: () => T | Promise<T>
    ): Promise<T> => {
      return space.responding(fn);
    },
  } as SpectrumInstance<Providers>;
}
