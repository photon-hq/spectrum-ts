import { definePlatform } from "../../platform/define";
import { messages as telegramMessages } from "./events";
import { send as telegramSend } from "./messages";
import {
  createTelegramCache,
  DEFAULT_CACHE_OPTIONS,
  messageCacheKey,
  type TelegramCacheOptions,
} from "./runtime/cache";
import { TelegramClient } from "./runtime/client";
import {
  configSchema,
  messageSchema,
  spaceParamsSchema,
  spaceSchema,
  type TelegramConfig,
  type TelegramRuntime,
  userSchema,
} from "./types";

const runtimeOf = (client: unknown): TelegramRuntime => {
  if (
    typeof client !== "object" ||
    client === null ||
    !("client" in client) ||
    !("cache" in client) ||
    !("abort" in client) ||
    !("me" in client)
  ) {
    throw new Error(
      "Telegram action invoked with an invalid runtime — expected the value returned by `createClient`."
    );
  }
  return client as TelegramRuntime;
};

const resolveCacheOptions = (
  cfg: TelegramConfig["cache"]
): TelegramCacheOptions => ({
  capacity: {
    messages: cfg?.messages ?? DEFAULT_CACHE_OPTIONS.capacity.messages,
    polls: cfg?.polls ?? DEFAULT_CACHE_OPTIONS.capacity.polls,
    pollVotes: cfg?.pollVotes ?? DEFAULT_CACHE_OPTIONS.capacity.pollVotes,
    albumConcurrent:
      cfg?.albumConcurrent ?? DEFAULT_CACHE_OPTIONS.capacity.albumConcurrent,
  },
  albumDebounceMs:
    cfg?.albumDebounceMs ?? DEFAULT_CACHE_OPTIONS.albumDebounceMs,
  albumCeilingMs: cfg?.albumCeilingMs ?? DEFAULT_CACHE_OPTIONS.albumCeilingMs,
  coalesceAlbums: cfg?.coalesceAlbums ?? DEFAULT_CACHE_OPTIONS.coalesceAlbums,
});

export const telegram = definePlatform("Telegram", {
  config: configSchema,

  user: {
    schema: userSchema,
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  message: {
    schema: messageSchema,
  },

  space: {
    schema: spaceSchema,
    params: spaceParamsSchema,
    resolve: async ({ input, client }) => {
      const runtime = runtimeOf(client);
      const chatIdSource =
        input.params?.chatId ??
        (input.users.length === 1 ? input.users[0]?.id : undefined);
      if (chatIdSource === undefined) {
        throw new Error(
          "Telegram space() requires params.chatId or a single resolved user"
        );
      }
      const chat = await runtime.client.invoke("getChat", {
        chat_id:
          typeof chatIdSource === "string"
            ? chatIdSource
            : Number(chatIdSource),
      });
      const space: {
        id: string;
        chatId: number;
        type: typeof chat.type;
        title?: string;
        username?: string;
      } = {
        id: String(chat.id),
        chatId: chat.id,
        type: chat.type,
      };
      if (chat.title !== undefined) {
        space.title = chat.title;
      }
      if (chat.username !== undefined) {
        space.username = chat.username;
      }
      return space;
    },
  },

  lifecycle: {
    createClient: async ({ config }): Promise<TelegramRuntime> => {
      const client = new TelegramClient({
        token: config.token,
        ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
      });
      // `getMe` doubles as a token-validity probe; the result is also reused
      // to synthesize a sender on outbound records that don't echo `from`.
      const me = await client.invoke("getMe", {});
      const cache = createTelegramCache(resolveCacheOptions(config.cache));
      return { client, abort: new AbortController(), cache, me };
    },

    destroyClient: async ({ client }) => {
      const runtime = runtimeOf(client);
      runtime.abort.abort();
      runtime.cache.destroy();
    },
  },

  messages: ({ client, config }) => {
    const runtime = runtimeOf(client);
    return telegramMessages(runtime, runtime.abort.signal, {
      ...(config.pollingTimeout === undefined
        ? {}
        : { timeout: config.pollingTimeout }),
      ...(config.dropPendingUpdates === undefined
        ? {}
        : { dropPendingUpdates: config.dropPendingUpdates }),
    });
  },

  send: async ({ space, content, client }) =>
    await telegramSend(runtimeOf(client), space.id, content),

  actions: {
    // Telegram has no general "fetch message by id" endpoint, so this is
    // backed by the in-process LRU populated by inbound + outbound paths.
    // Cold ids return `undefined`; disable with `cache.messages: 0`.
    getMessage: async ({ space, messageId, client }) =>
      runtimeOf(client).cache.messages.get(
        messageCacheKey(space.id, messageId)
      ),
  },
});
