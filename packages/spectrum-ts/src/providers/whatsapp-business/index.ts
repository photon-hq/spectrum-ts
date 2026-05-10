import { createClient } from "@photon-ai/whatsapp-business";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import { createCloudClients, disposeCloudAuth } from "./auth";
import { messages, reactToMessage, replyToMessage, send } from "./messages";
import {
  configSchema,
  isCloudConfig,
  spaceSchema,
  type WhatsAppClients,
} from "./types";

export const whatsappBusiness = definePlatform("WhatsApp Business", {
  config: configSchema,

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<WhatsAppClients> => {
      if (!isCloudConfig(config)) {
        return [
          createClient({
            accessToken: config.accessToken,
            appSecret: config.appSecret ?? "",
            phoneNumberId: config.phoneNumberId,
          }),
        ];
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "WhatsApp Business cloud mode requires projectId and projectSecret. " +
            "Either pass credentials to Spectrum(), or provide direct credentials: " +
            "whatsappBusiness.config({ accessToken, phoneNumberId })"
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
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    resolve: async ({ input }) => {
      if (input.users.length === 0) {
        throw new Error("WhatsApp space creation requires at least one user");
      }
      if (input.users.length > 1) {
        throw UnsupportedError.action(
          "createSpace",
          "WhatsApp Business",
          "only 1:1 conversations are supported"
        );
      }
      const user = input.users[0];
      if (!user) {
        throw new Error("WhatsApp space creation requires a user");
      }
      return { id: user.id };
    },
  },

  events: {
    messages: ({ client }) => messages(client),
  },

  actions: {
    send: async ({ space, content, client }) =>
      await send(client, space.id, content),

    reactToMessage: async ({ space, target, reaction, client }) => {
      await reactToMessage(client, space.id, target.id, reaction);
    },

    replyToMessage: async ({ space, messageId, content, client }) =>
      await replyToMessage(client, space.id, messageId, content),
  },
});
