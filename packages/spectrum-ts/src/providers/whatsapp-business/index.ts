import { createClient } from "@photon-ai/whatsapp-business";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import { createCloudClients, disposeCloudAuth } from "./auth";
import {
  messages,
  reactToMessage,
  replyToMessage,
  send,
  webhookMessages,
} from "./messages";
import {
  configSchema,
  isCloudConfig,
  isWebhookIngress,
  spaceSchema,
  type WhatsAppClients,
} from "./types";
import { getWebhookInbound, initWebhookState, webhook } from "./webhook";

export const whatsappBusiness = definePlatform("WhatsApp Business", {
  config: configSchema,

  static: {
    webhook,
  },

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
      store,
    }): Promise<WhatsAppClients> => {
      if (!isCloudConfig(config)) {
        if (isWebhookIngress(config) && !config.appSecret) {
          throw new Error(
            "WhatsApp Business webhook ingress requires `appSecret` for HMAC verification. " +
              "Set it on whatsappBusiness.config({ accessToken, appSecret, phoneNumberId, ingress: { mode: 'webhook', verifyToken } })."
          );
        }
        const client = createClient({
          accessToken: config.accessToken,
          appSecret: config.appSecret ?? "",
          phoneNumberId: config.phoneNumberId,
        });
        if (isWebhookIngress(config)) {
          initWebhookState(store, config.ingress, config.appSecret ?? "");
        }
        return [client];
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
    messages: ({ client, config, store }) => {
      if (isWebhookIngress(config)) {
        return webhookMessages(client, getWebhookInbound(store));
      }
      return messages(client);
    },
  },

  actions: {
    send: async ({ space, content, client }) => {
      return await send(client, space.id, content);
    },

    reactToMessage: async ({ space, target, reaction, client }) => {
      await reactToMessage(client, space.id, target.id, reaction);
    },

    replyToMessage: async ({ space, messageId, content, client }) => {
      return await replyToMessage(client, space.id, messageId, content);
    },
  },
});
