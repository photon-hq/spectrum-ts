import { definePlatform } from "../../platform/define";
import { messages } from "./events";
import {
  editMessage,
  reactToMessage,
  replyToMessage,
  send,
  startTyping,
} from "./messages";
import { TelegramClient } from "./runtime/client";
import {
  configSchema,
  spaceParamsSchema,
  spaceSchema,
  type TelegramRuntime,
  userSchema,
} from "./types";

const runtimeOf = (client: unknown): TelegramRuntime =>
  client as TelegramRuntime;

export const telegram = definePlatform("Telegram", {
  config: configSchema,

  user: {
    schema: userSchema,
    resolve: async ({ input }) => ({ id: input.userID }),
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
      await client.invoke("getMe", {});
      return { client, abort: new AbortController() };
    },

    destroyClient: async ({ client }) => {
      runtimeOf(client).abort.abort();
    },
  },

  events: {
    messages: ({ client, config }) => {
      const runtime = runtimeOf(client);
      return messages(runtime.client, runtime.abort.signal, {
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
      return await send(runtimeOf(client).client, space.id, content);
    },

    replyToMessage: async ({ space, messageId, content, client }) => {
      return await replyToMessage(
        runtimeOf(client).client,
        space.id,
        messageId,
        content
      );
    },

    editMessage: async ({ space, messageId, content, client }) => {
      await editMessage(runtimeOf(client).client, space.id, messageId, content);
    },

    reactToMessage: async ({ space, messageId, reaction, client }) => {
      await reactToMessage(
        runtimeOf(client).client,
        space.id,
        messageId,
        reaction
      );
    },

    startTyping: async ({ space, client }) => {
      await startTyping(runtimeOf(client).client, space.id);
    },
  },
});
