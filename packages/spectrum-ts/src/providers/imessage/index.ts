import { createClient, MessageEffect } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { withSpan } from "@photon-ai/otel";
import type { Attachment } from "../../content/attachment";
import type { Avatar } from "../../content/avatar";
import type { Edit } from "../../content/edit";
import type { Rename } from "../../content/rename";
import type { StreamText } from "../../content/stream-text";
import { definePlatform } from "../../platform/define";
import type { ProviderMessageRecord } from "../../platform/types";
import type { Message } from "../../types/message";
import type { Space } from "../../types/space";
import { UnsupportedError } from "../../utils/errors";

// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export { type BackgroundInput, background } from "./content/background";
export {
  type CustomizedMiniApp,
  type CustomizedMiniAppInput,
  type CustomizedMiniAppLayout,
  customizedMiniApp,
} from "./content/customized-mini-app";
export { effect, type IMessageMessageEffect } from "./content/effect";
export { read } from "./content/read";

import { createCloudClients, disposeCloudAuth } from "./auth";
import {
  type Background,
  type BackgroundInput,
  background as backgroundContent,
  isBackground,
} from "./content/background";
import {
  type CustomizedMiniApp,
  isCustomizedMiniApp,
} from "./content/customized-mini-app";
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
  sendCustomizedMiniApp as remoteSendCustomizedMiniApp,
  sendStreamText as remoteSendStreamText,
  setBackground as remoteSetBackground,
  setDisplayName as remoteSetDisplayName,
  setIcon as remoteSetIcon,
  startTyping as remoteStartTyping,
  stopTyping as remoteStopTyping,
} from "./remote/api";
import { getRemoteAttachment } from "./remote/attachments";
import {
  availablePhones,
  clientForPhone,
  isSharedMode,
  randomPhone,
} from "./remote/client";
import { chatTypeFromGuid, dmChatGuid } from "./remote/ids";
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

const handleStreamText = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: StreamText
): Promise<ProviderMessageRecord> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "streamText",
      "iMessage (local mode)",
      "streaming text responses require remote iMessage"
    );
  }
  const remote = clientForPhone(client, space.phone);
  return await remoteSendStreamText(remote, space.id, content);
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

const handleCustomizedMiniApp = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: CustomizedMiniApp
): Promise<ProviderMessageRecord> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "customized-mini-app",
      "iMessage (local mode)",
      "mini app cards require remote iMessage"
    );
  }
  const remote = clientForPhone(client, space.phone);
  return await remoteSendCustomizedMiniApp(remote, space.id, content);
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

const handleTyping = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  state: "start" | "stop"
): Promise<void> => {
  // Local mode has no typing API — silently no-op so callers can use
  // `space.startTyping()` uniformly across modes.
  if (isLocal(client)) {
    return;
  }
  const remote = clientForPhone(client, space.phone);
  if (state === "start") {
    await remoteStartTyping(remote, space.id);
  } else {
    await remoteStopTyping(remote, space.id);
  }
};

const handleRename = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: Rename
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "rename",
      "iMessage (local mode)",
      "renaming chats requires remote iMessage"
    );
  }
  if (space.type !== "group") {
    throw UnsupportedError.action(
      "rename",
      "iMessage",
      "only group chats can be renamed (this space is a DM)"
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteSetDisplayName(remote, space.id, content);
};

const handleAvatar = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: Avatar
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "avatar",
      "iMessage (local mode)",
      "setting group avatars requires remote iMessage"
    );
  }
  if (space.type !== "group") {
    throw UnsupportedError.action(
      "avatar",
      "iMessage",
      "only group chats have avatars (this space is a DM)"
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteSetIcon(remote, space.id, content);
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
    create: async ({ input, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action(
          "space.create",
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

      const addresses = input.users.map((u) => u.id);

      // Shared mode: one identity at the SHARED_PHONE sentinel. DM guids are
      // deterministic (`any;-;{address}`), so no server call is needed — but
      // the shared gateway cannot create group chats.
      if (isSharedMode(client)) {
        if (addresses.length > 1) {
          throw UnsupportedError.action(
            "space.create",
            "iMessage (shared mode)",
            "shared mode cannot create group chats — use a dedicated number, or space.get(chatGuid) for an existing group"
          );
        }
        return {
          id: dmChatGuid(addresses[0] ?? ""),
          type: "dm" as const,
          phone: SHARED_PHONE,
        };
      }

      // Dedicated mode: DMs and groups both go through the create API so the
      // server-issued guid is authoritative.
      const phone = input.params?.phone ?? randomPhone(client);
      const remote = clientForPhone(client, phone);
      const { chat } = await remote.chats.create(addresses);
      return {
        id: chat.guid,
        type: chat.isGroup ? ("group" as const) : ("dm" as const),
        phone,
      };
    },
    get: async ({ input, client }) => {
      if (isLocal(client)) {
        throw UnsupportedError.action(
          "space.get",
          "iMessage (local mode)",
          "local mode only supports replying to existing messages"
        );
      }

      if (client.length === 0) {
        throw new Error("No iMessage clients configured");
      }
      // No server call: the guid itself encodes the chat type, and sends
      // route by `phone`. Shared mode has a single identity, one configured
      // client is unambiguous, anything else needs an explicit phone.
      const phone = isSharedMode(client)
        ? SHARED_PHONE
        : (input.params?.phone ??
          (client.length === 1 ? client[0]?.phone : undefined));
      if (!phone) {
        throw new Error(
          "iMessage space.get requires params.phone when multiple clients " +
            `are configured. Available: ${availablePhones(client).join(", ")}`
        );
      }
      return {
        id: input.id,
        type: chatTypeFromGuid(input.id),
        phone,
      };
    },
    actions: {
      // Sugar: `space.background(input, opts?)` →
      // `space.send(background(input, opts?))`. Routed through the universal
      // send pipeline so the unsupported-content + warn-and-skip path on
      // local-mode iMessage is identical to the canonical form.
      background: async (
        space: Space,
        input: BackgroundInput,
        opts?: { mimeType?: string }
      ) => {
        await space.send(backgroundContent(input as never, opts));
      },
      // Sugar: `space.read(message)` → `space.send(read(message))`.
      read: async (space: Space, message: Message) => {
        await space.send(readContent(message));
      },
    },
  },

  message: {
    schema: messageSchema,
    actions: {
      // Sugar: `message.read()` → `message.space.send(read(self))`.
      // `buildMessage` injects the message as the first argument; callers
      // pass nothing.
      read: async (message: Message) => {
        await message.space.send(readContent(message));
      },
    },
  },

  messages: ({ client, projectConfig }) =>
    isLocal(client)
      ? localMessages(client)
      : remoteMessages(client, projectConfig),

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
      await handleTyping(client, space, content.state);
      return;
    }
    if (content.type === "edit") {
      await handleEdit(client, space, content);
      return;
    }
    if (content.type === "streamText") {
      return await handleStreamText(client, space, content);
    }
    if (content.type === "rename") {
      await handleRename(client, space, content);
      return;
    }
    if (content.type === "avatar") {
      await handleAvatar(client, space, content);
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
    // Also iMessage-only, but unlike `background`/`read` it produces a real
    // message — return the record rather than treating it as fire-and-forget.
    if (isCustomizedMiniApp(content)) {
      return await handleCustomizedMiniApp(client, space, content);
    }
    if (isLocal(client)) {
      return await localSend(client, space.id, content);
    }
    const remote = clientForPhone(client, space.phone);
    return await remoteSend(remote, space.id, content);
  },

  actions: {
    getMessage: async ({ client }, space, messageId) => {
      if (isLocal(client)) {
        return localGetMessage(client, messageId);
      }
      const remote = clientForPhone(client, space.phone);
      return remoteGetMessage(remote, space.id, messageId, space.phone);
    },
    // Fetch an attachment by GUID. Returns a spectrum `Attachment` whose
    // `.read()` / `.stream()` lazily download the bytes — calling both
    // issues two independent gRPC downloads, so cache `.read()` if you
    // need the bytes more than once. Returns `undefined` for unknown
    // GUIDs. Local-mode iMessage is not supported.
    getAttachment: async (
      { client }: { client: IMessageClient },
      guid: string,
      phone?: string
    ): Promise<Attachment | undefined> => {
      if (isLocal(client)) {
        throw UnsupportedError.action(
          "getAttachment",
          "iMessage (local mode)",
          "fetching attachments by GUID requires remote iMessage"
        );
      }
      if (client.length === 0) {
        throw new Error("No iMessage clients configured");
      }
      const routedPhone = (() => {
        if (isSharedMode(client)) {
          return SHARED_PHONE;
        }
        if (phone) {
          return phone;
        }
        if (client.length === 1) {
          // biome-ignore lint/style/noNonNullAssertion: length checked above
          return client[0]!.phone;
        }
        throw new Error(
          `imessage.getAttachment requires a phone in multi-phone mode. Available: ${availablePhones(client).join(", ")}`
        );
      })();
      const remote = clientForPhone(client, routedPhone);
      return withSpan(
        "spectrum.imessage.getAttachment",
        {
          "spectrum.provider": "iMessage",
          "spectrum.imessage.attachment.guid": guid,
          "spectrum.imessage.phone": routedPhone,
        },
        () => getRemoteAttachment(remote, guid)
      );
    },
  },
});
