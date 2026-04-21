import {
  createClient,
  type WhatsAppClient,
} from "@photon-ai/whatsapp-business";
import { definePlatform } from "../../platform/define";
import { messages, reactToMessage, replyToMessage, send } from "./messages";
import { configSchema, spaceSchema } from "./types";

export const whatsappBusiness = definePlatform("WhatsApp Business", {
  config: configSchema,

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
        throw new Error(
          "WhatsApp Business API only supports 1:1 conversations"
        );
      }
      const user = input.users[0];
      if (!user) {
        throw new Error("WhatsApp space creation requires a user");
      }
      return { id: user.id };
    },
  },

  lifecycle: {
    createClient: async ({ config }): Promise<WhatsAppClient> => {
      return createClient({
        accessToken: config.accessToken,
        phoneNumberId: config.phoneNumberId,
        appSecret: config.appSecret ?? "",
      });
    },

    destroyClient: async ({ client }: { client: WhatsAppClient }) => {
      await client.close();
    },
  },

  events: {
    messages: ({ client }) => messages(client as WhatsAppClient),
  },

  actions: {
    send: async ({ space, content, client }) => {
      return await send(client as WhatsAppClient, space.id, content);
    },

    reactToMessage: async ({ space, messageId, reaction, client }) => {
      await reactToMessage(
        client as WhatsAppClient,
        space.id,
        messageId,
        reaction
      );
    },

    replyToMessage: async ({ space, messageId, content, client }) => {
      return await replyToMessage(
        client as WhatsAppClient,
        space.id,
        messageId,
        content
      );
    },
  },
});
