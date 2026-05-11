import { definePlatform } from "../../platform/define";
import { messages as telegramMessages } from "./events";
import { chatToSpace } from "./identity";
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

const asRuntime = (client: unknown): TelegramRuntime =>
  client as TelegramRuntime;

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
      const runtime = asRuntime(client);
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
      return chatToSpace(chat);
    },
  },

  lifecycle: {
    createClient: async ({ config }): Promise<TelegramRuntime> => {
      const client = new TelegramClient({
        token: config.token,
        ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
      });
      const me = await client.invoke("getMe", {});
      const cache = createTelegramCache(resolveCacheOptions(config.cache));
      return { client, abort: new AbortController(), cache, me };
    },

    destroyClient: async ({ client }) => {
      const runtime = asRuntime(client);
      runtime.abort.abort();
      runtime.cache.destroy();
    },
  },

  messages: ({ client, config }) => {
    const runtime = asRuntime(client);
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
    await telegramSend(asRuntime(client), space.id, content),

  actions: {
    getMessage: async ({ space, messageId, client }) =>
      asRuntime(client).cache.messages.get(
        messageCacheKey(space.id, messageId)
      ),
  },
});
