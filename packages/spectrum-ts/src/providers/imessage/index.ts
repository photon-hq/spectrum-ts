import { createClient, MessageEffect } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Edit } from "../../content/edit";
import { definePlatform } from "../../platform/define";
import { UnsupportedError } from "../../utils/errors";

// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export { type BackgroundInput, background } from "./content/background";
export { effect, type IMessageMessageEffect } from "./content/effect";
export { read } from "./content/read";

import { createCloudClients, disposeCloudAuth } from "./auth";
import {
  type Background,
  background as backgroundContent,
  isBackground,
} from "./content/background";
import { isRead, read as readContent } from "./content/read";
import {
  getMessage as localGetMessage,
  messages as localMessages,
  send as localSend,
} from "./local/api";
import {
  editMessage as remoteEditMessage,
  getMessage as remoteGetMessage,
  markRead as remoteMarkRead,
  messages as remoteMessages,
  reactToMessage as remoteReactToMessage,
  replyToMessage as remoteReplyToMessage,
  send as remoteSend,
  setBackground as remoteSetBackground,
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

const handleEdit = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: Edit
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action("edit", "iMessage (local mode)");
  }
  if (content.content.type !== "text") {
    // Mirrors `remoteEditMessage`'s own check — surface as an
    // UnsupportedError so dispatchSend warn-and-skips uniformly.
    throw UnsupportedError.content(
      "edit",
      "iMessage",
      `only text content can be edited (got "${content.content.type}")`
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteEditMessage(remote, space.id, content.target.id, content.content);
};

const handleBackground = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: Background
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "background",
      "iMessage (local mode)",
      "chat backgrounds require remote iMessage"
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteSetBackground(remote, space.id, content);
};

const handleRead = async (
  client: IMessageClient,
  space: { id: string; phone: string }
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "read",
      "iMessage (local mode)",
      "marking chats as read requires remote iMessage"
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteMarkRead(remote, space.id);
};

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
    actions: {
      // Sugar: `space.background(input, opts?)` →
      // `space.send(background(input, opts?))`. Wired through the universal
      // send pipeline so the unsupported-content + warn-and-skip path on
      // local-mode iMessage is identical to the canonical form.
      background: backgroundContent,
      // Sugar: `space.read(message)` → `space.send(read(message))`. Same
      // routing as `background` — the canonical form is the long-form
      // `space.send(read(message))`.
      read: readContent,
    },
  },

  message: {
    schema: messageSchema,
    actions: {
      // Sugar: `message.read()` → `space.send(read(self))`. `buildMessage`
      // injects `self` as the first argument; callers pass nothing.
      read: readContent,
    },
  },

  messages: ({ client }) =>
    isLocal(client) ? localMessages(client) : remoteMessages(client),

  send: async ({ space, content, client }) => {
    if (content.type === "reply") {
      if (isLocal(client)) {
        throw UnsupportedError.action("reply", "iMessage (local mode)");
      }
      if (isPollContent(content.target.content)) {
        throw UnsupportedError.action(
          "reply",
          "iMessage",
          "iMessage polls do not support replies"
        );
      }
      const remote = clientForPhone(client, space.phone);
      return await remoteReplyToMessage(
        remote,
        space.id,
        content.target.id,
        content.content
      );
    }
    if (content.type === "reaction") {
      if (isLocal(client)) {
        throw UnsupportedError.action("react", "iMessage (local mode)");
      }
      if (isPollContent(content.target.content)) {
        throw UnsupportedError.action(
          "react",
          "iMessage",
          "iMessage polls do not support reactions"
        );
      }
      const remote = clientForPhone(client, space.phone);
      // `content.target` is statically typed as the generic `Message`, but
      // execution only reaches this iMessage `send` action when the target
      // came from the iMessage stream — hence the unknown-cast widen.
      await remoteReactToMessage(
        remote,
        space.id,
        content.target as unknown as IMessageMessage,
        content.emoji
      );
      return;
    }
    if (content.type === "typing") {
      // Local mode has no typing API — silently no-op so callers can use
      // `space.startTyping()` uniformly across modes.
      if (isLocal(client)) {
        return;
      }
      const remote = clientForPhone(client, space.phone);
      if (content.state === "start") {
        await remoteStartTyping(remote, space.id);
      } else {
        await remoteStopTyping(remote, space.id);
      }
      return;
    }
    if (content.type === "edit") {
      await handleEdit(client, space, content);
      return;
    }
    // `Background` and `Read` are iMessage-only and live outside the
    // universal `Content` union — narrow via runtime guards rather than
    // `content.type ===` checks (those literals aren't members of
    // `Content["type"]`).
    if (isBackground(content)) {
      await handleBackground(client, space, content);
      return;
    }
    if (isRead(content)) {
      await handleRead(client, space);
      return;
    }
    if (isLocal(client)) {
      return await localSend(client, space.id, content);
    }
    const remote = clientForPhone(client, space.phone);
    return await remoteSend(remote, space.id, content);
  },

  actions: {
    getMessage: async ({ space, messageId, client }) => {
      if (isLocal(client)) {
        return localGetMessage(client, messageId);
      }
      const remote = clientForPhone(client, space.phone);
      return remoteGetMessage(remote, space.id, messageId, space.phone);
    },
  },
});
