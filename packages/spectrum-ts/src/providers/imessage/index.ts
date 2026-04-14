import { createClient, directChat } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { definePlatform } from "../../platform/define";
import { createCloudClients, disposeCloudAuth } from "./auth";
import { messages as localMessages, send as localSend } from "./local";
import {
  messages as remoteMessages,
  reactToMessage as remoteReactToMessage,
  replyToMessage as remoteReplyToMessage,
  send as remoteSend,
  startTyping as remoteStartTyping,
  stopTyping as remoteStopTyping,
} from "./remote";
import {
  configSchema,
  type IMessageClient,
  isLocal,
  spaceSchema,
} from "./types";

export const imessage = definePlatform("iMessage", {
  config: configSchema,

  static: {
    tapbacks: {
      love: "love",
      like: "like",
      dislike: "dislike",
      laugh: "laugh",
      emphasize: "emphasize",
      question: "question",
    } as const,
  },

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    resolve: async ({ input, client }) => {
      if (isLocal(client)) {
        throw new Error(
          "Space creation is not supported in local mode. Local mode only supports replying to messages."
        );
      }

      if (input.users.length === 0) {
        throw new Error("iMessage space creation requires at least one user");
      }

      const addresses = input.users.map((u) => u.id);

      if (input.users.length === 1) {
        return {
          id: directChat(addresses[0] ?? "") as string,
          type: "dm" as const,
        };
      }

      const remote = client[0];
      if (!remote) {
        throw new Error("No remote iMessage client available");
      }

      const { chat } = await remote.chats.create(addresses);
      return { id: chat.guid as string, type: "group" as const };
    },
  },

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<IMessageClient> => {
      if (config.local) {
        return new IMessageSDK();
      }

      if (config.clients) {
        const entries = Array.isArray(config.clients)
          ? config.clients
          : [config.clients];
        return entries.map((e) =>
          createClient({ address: e.address, tls: true, token: e.token })
        );
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "iMessage requires projectId and projectSecret. " +
            "Either pass credentials to Spectrum(), use local mode: imessage.config({ local: true }), " +
            "or provide explicit client config: imessage.config({ clients: [...] })"
        );
      }

      return await createCloudClients(projectId, projectSecret);
    },

    destroyClient: async ({ client }: { client: IMessageClient }) => {
      if (isLocal(client)) {
        await client.close();
        return;
      }
      await disposeCloudAuth(client);
      await Promise.all(client.map((c) => c.close()));
    },
  },

  events: {
    messages: ({ client }) =>
      isLocal(client) ? localMessages(client) : remoteMessages(client),
  },

  actions: {
    send: async ({ space, content, client }) => {
      for (const item of content) {
        if (isLocal(client)) {
          await localSend(client, space.id, item);
        } else {
          await remoteSend(client, space.id, item);
        }
      }
    },
    startTyping: async ({ space, client }) => {
      if (isLocal(client)) {
        return;
      }
      await remoteStartTyping(client, space.id);
    },
    stopTyping: async ({ space, client }) => {
      if (isLocal(client)) {
        return;
      }
      await remoteStopTyping(client, space.id);
    },
    reactToMessage: async ({ space, messageId, reaction, client }) => {
      if (isLocal(client)) {
        return;
      }
      await remoteReactToMessage(client, space.id, messageId, reaction);
    },
    replyToMessage: async ({ space, messageId, content, client }) => {
      if (isLocal(client)) {
        return;
      }
      for (const item of content) {
        await remoteReplyToMessage(client, space.id, messageId, item);
      }
    },
  },
});
