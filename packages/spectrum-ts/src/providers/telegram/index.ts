import { definePlatform } from "../../platform/define";
import { messages } from "./events";
import {
  editMessage,
  reactToMessage,
  replyToMessage,
  send,
  startTyping,
} from "./messages";
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

const runtimeOf = (client: unknown): TelegramRuntime =>
  client as TelegramRuntime;

// Merge user config knobs into a fully-resolved cache options bundle.
// Any field the user omits falls back to `DEFAULT_CACHE_OPTIONS`. Setting a
// capacity to 0 disables that slot (e.g. `cache: { messages: 0 }` makes
// `getMessage` always return `undefined`).
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
      // `getMe` doubles as a token-validity probe and a place to capture the
      // bot's own User. We hold onto the User to synthesize senders on
      // outbound records that don't echo `from` (reactions).
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

  events: {
    messages: ({ client, config }) => {
      const runtime = runtimeOf(client);
      return messages(runtime, runtime.abort.signal, {
        ...(config.pollingTimeout === undefined
          ? {}
          : { timeout: config.pollingTimeout }),
        ...(config.dropPendingUpdates === undefined
          ? {}
          : { dropPendingUpdates: config.dropPendingUpdates }),
      });
    },
  },

  actions: {
    send: async ({ space, content, client }) => {
      return await send(runtimeOf(client), space.id, content);
    },

    replyToMessage: async ({ space, messageId, content, client }) => {
      return await replyToMessage(
        runtimeOf(client),
        space.id,
        messageId,
        content
      );
    },

    editMessage: async ({ space, messageId, content, client }) => {
      await editMessage(runtimeOf(client), space.id, messageId, content);
    },

    reactToMessage: async ({ space, target, reaction, client }) => {
      await reactToMessage(
        runtimeOf(client).client,
        space.id,
        target.id,
        reaction
      );
    },

    // Telegram's Bot API has no general "fetch message by id" endpoint —
    // `messages.get` only exists for forwarded/replied-to message echoes
    // already inside an Update. We back `getMessage` with the runtime's
    // in-process LRU (every inbound and every outbound send/reply/edit
    // writes through it). Cold ids return `undefined` so callers can
    // degrade gracefully, matching iMessage local-mode semantics. Disable
    // the cache by setting `config.cache.messages = 0` to restore the
    // pre-cache "always undefined" behaviour.
    //
    // The cache is keyed by `${spaceId}:${messageId}` because Telegram
    // `message_id` is only unique per chat — see `messageCacheKey` in
    // `runtime/cache.ts` for the rationale.
    getMessage: async ({ space, messageId, client }) =>
      runtimeOf(client).cache.messages.get(
        messageCacheKey(space.id, messageId)
      ),

    startTyping: async ({ space, client }) => {
      await startTyping(runtimeOf(client).client, space.id);
    },
  },
});
