import z from "zod";
import { resolveContents } from "./content/resolve";
import type { Content, ContentInput } from "./content/types";
import type {
  AnyPlatformDef,
  CustomEventStreams,
  PlatformProviderConfig,
  SpectrumLike,
} from "./platform/types";
import type { Message } from "./types/message";
import type { Space } from "./types/space";
import { type ManagedStream, mergeStreams, stream } from "./utils/stream";

type ProviderMessageRecord = {
  id: string;
  content: Content;
  sender: { id: string } & Record<string, unknown>;
  space: { id: string } & Record<string, unknown>;
  timestamp?: Date;
} & Record<string, unknown>;

const providerMessageCoreKeys = new Set([
  "content",
  "id",
  "sender",
  "space",
  "timestamp",
]);

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
      ...content: [ContentInput, ...ContentInput[]]
    ): Promise<void>;
    responding<T>(space: Space, fn: () => T | Promise<T>): Promise<T>;
  };

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const spectrumConfigSchema = z.union([
  z.object({
    projectId: z.string().min(1),
    projectSecret: z.string().min(1),
    providers: z.array(z.custom<PlatformProviderConfig>()),
  }),
  z.object({
    projectId: z.undefined().optional(),
    projectSecret: z.undefined().optional(),
    providers: z.array(z.custom<PlatformProviderConfig>()),
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
      }
    | {
        projectId?: never;
        projectSecret?: never;
        providers: [...Providers];
      }
): Promise<SpectrumInstance<Providers>> {
  spectrumConfigSchema.parse(options);

  const { projectId, projectSecret, providers } = options;

  const platformStates = new Map<
    string,
    { client: unknown; config: unknown; definition: AnyPlatformDef }
  >();

  // Custom event streams keyed by event name
  const customEventStreams = new Map<string, ManagedStream<unknown>>();

  let stopped = false;

  // Initialize all provider clients eagerly
  for (const provider of providers) {
    const providerConfig = provider as PlatformProviderConfig;
    const def = providerConfig.__definition;
    const userConfig = def.config.parse(providerConfig.config);

    const client = await def.lifecycle.createClient({
      config: userConfig,
      projectId,
      projectSecret,
    });

    platformStates.set(def.name, {
      client,
      config: userConfig,
      definition: def,
    });
  }

  const adaptIterable = <T>(iterable: AsyncIterable<T>): ManagedStream<T> => {
    return stream<T>((emit, end) => {
      const iterator = iterable[Symbol.asyncIterator]();

      (async () => {
        try {
          let result = await iterator.next();
          while (!result.done) {
            emit(result.value);
            result = await iterator.next();
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await iterator.return?.();
      };
    });
  };

  const createProviderMessagesStream = (state: {
    client: unknown;
    config: unknown;
    definition: AnyPlatformDef;
  }): ManagedStream<[Space, Message]> => {
    const { client, config, definition } = state;
    const raw = definition.events.messages({
      client,
      config,
    }) as AsyncIterable<ProviderMessageRecord>;

    const bindSend = async function* (): AsyncIterable<[Space, Message]> {
      for await (const msg of raw) {
        const extraEntries = Object.entries(msg).filter(
          ([key]) => !providerMessageCoreKeys.has(key)
        );
        const extra = Object.fromEntries(extraEntries);
        const parsedExtra = definition.message?.schema
          ? definition.message.schema.parse(extra)
          : {};
        const spaceRef = {
          ...msg.space,
          __platform: definition.name,
        };
        const typingCtx = { space: spaceRef, client, config };
        const space = {
          ...spaceRef,
          send: async (...content: [ContentInput, ...ContentInput[]]) => {
            const resolved = await resolveContents(content);
            for (const item of resolved) {
              await definition.actions.send({
                ...typingCtx,
                content: item,
              });
            }
          },
          startTyping: async () => {
            await definition.actions.startTyping?.(typingCtx);
          },
          stopTyping: async () => {
            await definition.actions.stopTyping?.(typingCtx);
          },
          responding: async <T>(fn: () => T | Promise<T>): Promise<T> => {
            await definition.actions.startTyping?.(typingCtx);
            try {
              return await fn();
            } finally {
              await definition.actions.stopTyping?.(typingCtx).catch(() => {});
            }
          },
        };
        const normalizedMessage = {
          ...parsedExtra,
          id: msg.id,
          content: msg.content,
          platform: definition.name,
          react: async (reaction: string): Promise<void> => {
            if (!definition.actions.reactToMessage) {
              return;
            }
            await definition.actions.reactToMessage({
              space: spaceRef,
              messageId: msg.id,
              reaction,
              client,
              config,
            });
          },
          reply: async (
            ...content: [ContentInput, ...ContentInput[]]
          ): Promise<void> => {
            if (!definition.actions.replyToMessage) {
              return;
            }
            const resolved = await resolveContents(content);
            for (const item of resolved) {
              await definition.actions.replyToMessage({
                space: spaceRef,
                messageId: msg.id,
                content: item,
                client,
                config,
              });
            }
          },
          sender: {
            ...msg.sender,
            __platform: definition.name,
          },
          space,
          timestamp: msg.timestamp ?? new Date(),
        };

        yield [space, normalizedMessage];
      }
    };

    return adaptIterable(bindSend());
  };

  const createMessagesStream = (): ManagedStream<[Space, Message]> => {
    return stream<[Space, Message]>(async (emit, end) => {
      const merged = mergeStreams(
        Array.from(platformStates.values(), createProviderMessagesStream)
      );

      (async () => {
        try {
          for await (const value of merged) {
            emit(value);
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await merged.close();
      };
    });
  };

  const createCustomEventStream = (
    eventName: string
  ): ManagedStream<unknown> => {
    return stream<unknown>(async (emit, end) => {
      const providerStreams = Array.from(platformStates.values(), (state) => {
        const { client, config, definition } = state;
        const producer = definition.events[eventName] as
          | ((ctx: {
              client: unknown;
              config: unknown;
            }) => AsyncIterable<unknown>)
          | undefined;
        if (!producer) {
          return undefined;
        }

        const providerEvents = producer({ client, config });
        const annotatePlatform = async function* (): AsyncIterable<unknown> {
          for await (const value of providerEvents) {
            yield { ...(value as object), platform: definition.name };
          }
        };

        return adaptIterable(annotatePlatform());
      }).filter(
        (value): value is ManagedStream<unknown> => value !== undefined
      );

      const merged = mergeStreams(providerStreams);

      (async () => {
        try {
          for await (const value of merged) {
            emit(value);
          }
          end();
        } catch (error) {
          end(error);
        }
      })();

      return async () => {
        await merged.close();
      };
    });
  };

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
    customEventStreams.clear();
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

  const messages = messagesStream as AsyncIterable<[Space, Message]>;

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
    send: async (
      space: Space,
      ...content: [ContentInput, ...ContentInput[]]
    ) => {
      await space.send(...content);
    },
    responding: async <T>(
      space: Space,
      fn: () => T | Promise<T>
    ): Promise<T> => {
      return space.responding(fn);
    },
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
      return undefined;
    },
  }) as SpectrumInstance<Providers>;
}
