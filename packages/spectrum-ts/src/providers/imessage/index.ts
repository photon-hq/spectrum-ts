import { createClient, MessageEffect } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";

// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helper
export { effect, type IMessageMessageEffect } from "./content/effect";

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
import { clientForPhone, isSharedMode, randomPhone } from "./remote/client";
import { dmChatGuid } from "./remote/ids";
import {
  configSchema,
  type IMessageClient,
  type IMessageMessage,
  isLocal,
  messageSchema,
  SHARED_PHONE,
  spaceParamsSchema,
  spaceSchema,
} from "./types";

const isPollContent = (content: { type: string }): boolean =>
  content.type === "poll" || content.type === "poll_option";

export const imessage = definePlatform("iMessage", {
  config: configSchema,

  static: {
    effect: {
      message: MessageEffect,
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
        return entries.map((e) => ({
          phone: e.phone,
          client: createClient({
            address: e.address,
            tls: true,
            token: e.token,
          }),
        }));
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

    destroyClient: async ({ client }) => {
      if (isLocal(client)) {
        await client.close();
        return;
      }
      await disposeCloudAuth(client);
      await Promise.all(client.map((entry) => entry.client.close()));
    },
  },

  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    params: spaceParamsSchema,
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

      if (client.length === 0) {
        throw new Error("No iMessage clients configured");
      }
      // Shared mode: ignore any user-supplied phone — there is only one
      // identity, tagged at the SHARED_PHONE sentinel.
      const phone = isSharedMode(client)
        ? SHARED_PHONE
        : (input.params?.phone ?? randomPhone(client));
      const remote = clientForPhone(client, phone);
      const addresses = input.users.map((u) => u.id);

      if (input.users.length === 1) {
        return {
          id: dmChatGuid(addresses[0] ?? ""),
          type: "dm" as const,
          phone,
        };
      }

      const { chat } = await remote.chats.create(addresses);
      return { id: chat.guid as string, type: "group" as const, phone };
    },
  },

  message: {
    schema: messageSchema,
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
      const remote = clientForPhone(client, space.phone);
      return await remoteSend(remote, space.id, content);
    },
    startTyping: async ({ space, client }) => {
      if (isLocal(client)) {
        return;
      }
      const remote = clientForPhone(client, space.phone);
      await remoteStartTyping(remote, space.id);
    },
    stopTyping: async ({ space, client }) => {
      if (isLocal(client)) {
        return;
      }
      const remote = clientForPhone(client, space.phone);
      await remoteStopTyping(remote, space.id);
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
      const remote = clientForPhone(client, space.phone);
      await remoteReactToMessage(
        remote,
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
      const remote = clientForPhone(client, space.phone);
      return await remoteReplyToMessage(remote, space.id, messageId, content);
    },
    editMessage: async ({ space, messageId, content, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action("edit", "iMessage (local mode)");
      }
      const remote = clientForPhone(client, space.phone);
      await remoteEditMessage(remote, space.id, messageId, content);
    },
    getMessage: async ({ space, messageId, client }) => {
      if (isLocal(client)) {
        return localGetMessage(client, messageId);
      }
      const remote = clientForPhone(client, space.phone);
      return remoteGetMessage(remote, space.id, messageId, space.phone);
    },
  },
});
