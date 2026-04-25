import { createClient, directChat } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";
import { createCloudClients, disposeCloudAuth } from "./auth";
import {
  getMessage as localGetMessage,
  messages as localMessages,
  send as localSend,
} from "./local/api";
import {
  editMessage as remoteEditMessage,
  getMessage as remoteGetMessage,
  messages as remoteMessages,
  reactToMessage as remoteReactToMessage,
  replyToMessage as remoteReplyToMessage,
  send as remoteSend,
  startTyping as remoteStartTyping,
  stopTyping as remoteStopTyping,
} from "./remote/api";
import {
  configSchema,
  type IMessageClient,
  type IMessageMessage,
  isLocal,
  messageSchema,
  spaceSchema,
} from "./types";

const isPollContent = (content: { type: string }): boolean =>
  content.type === "poll" || content.type === "poll_option";

export const imessage = definePlatform("iMessage", {
  config: configSchema,

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    resolve: async ({ input, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action(
          "createSpace",
          "iMessage (local mode)",
          "local mode only supports replying to existing messages"
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

  message: {
    schema: messageSchema,
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
      if (isLocal(client)) {
        return await localSend(client, space.id, content);
      }
      return await remoteSend(client, space.id, content);
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
    reactToMessage: async ({ space, target, reaction, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action("react", "iMessage (local mode)");
      }
      if (isPollContent(target.content)) {
        throw UnsupportedError.action(
          "react",
          "iMessage",
          "iMessage polls do not support reactions"
        );
      }
      await remoteReactToMessage(
        client,
        space.id,
        target as IMessageMessage,
        reaction
      );
    },
    replyToMessage: async ({ space, messageId, target, content, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action("reply", "iMessage (local mode)");
      }
      if (isPollContent(target.content)) {
        throw UnsupportedError.action(
          "reply",
          "iMessage",
          "iMessage polls do not support replies"
        );
      }
      return await remoteReplyToMessage(client, space.id, messageId, content);
    },
    editMessage: async ({ space, messageId, content, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action("edit", "iMessage (local mode)");
      }
      await remoteEditMessage(client, space.id, messageId, content);
    },
    getMessage: async ({ space, messageId, client }) => {
      if (isLocal(client)) {
        return localGetMessage(client, messageId);
      }
      return remoteGetMessage(client, space.id, messageId);
    },
  },
});
