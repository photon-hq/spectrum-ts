import { createClient } from "@photon-ai/telegram";
import { definePlatform } from "../../platform/define";
import { createCloudClients, disposeCloudAuth } from "./auth";
import { messages, send } from "./messages";
import {
  configSchema,
  isCloudConfig,
  messageSchema,
  spaceParamsSchema,
  spaceSchema,
  type TelegramClients,
  userSchema,
} from "./types";

export const telegram = definePlatform("Telegram", {
  config: configSchema,

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<TelegramClients> => {
      if (!isCloudConfig(config)) {
        return [
          createClient({
            botToken: config.botToken,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
          }),
        ];
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "Telegram cloud mode requires projectId and projectSecret. " +
            "Either pass credentials to Spectrum(), or provide direct credentials: " +
            "telegram.config({ botToken })"
        );
      }

      return await createCloudClients(projectId, projectSecret);
    },

    destroyClient: async ({ client }) => {
      await disposeCloudAuth(client);
      await Promise.all(client.map((c) => c.close()));
    },
  },

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
    resolve: async ({ input }) => {
      // v1: derive the chat id from explicit `params.chatId` or a single
      // resolved user. The SDK does not yet expose a `getChat` RPC, so
      // metadata (type/title/username) is not populated here — see
      // PLAN-MIGRATION.md for the follow-up ResolveChat work.
      const chatIdSource =
        input.params?.chatId ??
        (input.users.length === 1 ? input.users[0]?.id : undefined);
      if (chatIdSource === undefined) {
        throw new Error(
          "Telegram space() requires params.chatId or a single resolved user"
        );
      }
      return { id: String(chatIdSource) };
    },
  },

  messages: ({ client }) => messages(client),

  send: async ({ space, content, client }) =>
    await send(client, space.id, content),
});
