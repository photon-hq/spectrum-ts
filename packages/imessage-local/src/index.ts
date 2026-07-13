import { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  type Attachment,
  type Content,
  definePlatform,
  type Space,
  text,
  UnsupportedError,
} from "@spectrum-ts/core";

// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export { read } from "@spectrum-ts/core";
export {
  type BackgroundInput,
  background,
} from "../../imessage/src/content/background";
export {
  type ContactCard,
  nativeContactCard,
} from "../../imessage/src/content/contact-card";
export {
  type CustomizedMiniApp,
  type CustomizedMiniAppInput,
  type CustomizedMiniAppLayout,
  customizedMiniApp,
} from "../../imessage/src/content/customized-mini-app";
export {
  effect,
  type IMessageMessageEffect,
} from "../../imessage/src/content/effect";

import {
  type BackgroundInput,
  background as backgroundContent,
  isBackground,
} from "../../imessage/src/content/background";
import {
  isContactCard,
  nativeContactCard as nativeContactCardContent,
} from "../../imessage/src/content/contact-card";
import { isCustomizedMiniApp } from "../../imessage/src/content/customized-mini-app";
import { messageEffects } from "../../imessage/src/content/effect";
import { chatTypeFromGuid, dmChatGuid } from "./ids";
import {
  getMessage as localGetMessage,
  messages as localMessages,
  send as localSend,
} from "./local/api";
import {
  configSchema,
  messageSchema,
  spaceParamsSchema,
  spaceSchema,
  userSchema,
} from "./types";

const LOCAL_PLATFORM = "iMessage (local mode)";

const unsupportedAction = (action: string, detail?: string): never => {
  throw UnsupportedError.action(action, LOCAL_PLATFORM, detail);
};

const handleLocalOnlySend = async (
  client: IMessageSDK,
  spaceId: string,
  content: Content
) => {
  if (content.type === "typing") {
    return;
  }
  if (content.type === "app") {
    return await localSend(
      client,
      spaceId,
      await text(await content.url()).build()
    );
  }
  if (content.type === "edit") {
    return unsupportedAction("edit");
  }
  if (content.type === "unsend") {
    return unsupportedAction("unsend");
  }
  if (content.type === "streamText") {
    return unsupportedAction(
      "streamText",
      "streaming text responses require remote iMessage"
    );
  }
  if (content.type === "rename") {
    return unsupportedAction(
      "rename",
      "renaming chats requires remote iMessage"
    );
  }
  if (content.type === "avatar") {
    return unsupportedAction(
      "avatar",
      "setting group avatars requires remote iMessage"
    );
  }
  if (content.type === "addMember") {
    return unsupportedAction(
      "addMember",
      "adding members requires remote iMessage"
    );
  }
  if (content.type === "removeMember") {
    return unsupportedAction(
      "removeMember",
      "removing members requires remote iMessage"
    );
  }
  if (content.type === "leaveSpace") {
    return unsupportedAction(
      "leaveSpace",
      "leaving chats requires remote iMessage"
    );
  }
  if (content.type === "read") {
    return unsupportedAction(
      "read",
      "marking chats as read requires remote iMessage"
    );
  }
  if (content.type === "reply") {
    return unsupportedAction("reply");
  }
  if (content.type === "reaction") {
    return unsupportedAction("react");
  }
  if (isBackground(content)) {
    return unsupportedAction(
      "background",
      "chat backgrounds require remote iMessage"
    );
  }
  if (isContactCard(content)) {
    return unsupportedAction(
      "shareContactCard",
      "sharing the contact card requires remote iMessage"
    );
  }
  if (isCustomizedMiniApp(content)) {
    return unsupportedAction(
      "customized-mini-app",
      "mini app cards require remote iMessage"
    );
  }
  return await localSend(client, spaceId, content);
};

export const imessage = definePlatform("iMessage", {
  config: configSchema,

  static: {
    effect: {
      message: messageEffects,
    },
  },

  lifecycle: {
    createClient: async (): Promise<IMessageSDK> => new IMessageSDK(),
    destroyClient: async ({ client }) => {
      await client.close();
    },
  },

  user: {
    schema: userSchema,
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    params: spaceParamsSchema,
    create: async ({ input }) => {
      if (input.users.length === 0) {
        throw new Error("iMessage space creation requires at least one user");
      }
      if (input.users.length > 1) {
        return unsupportedAction(
          "space.create",
          "local mode cannot create group chats — use space.get(chatGuid) for an existing group"
        );
      }
      return {
        id: dmChatGuid(input.users[0]?.id ?? ""),
        type: "dm" as const,
        phone: "",
      };
    },
    get: async ({ input }) => ({
      id: input.id,
      type: chatTypeFromGuid(input.id),
      phone: "",
    }),
    actions: {
      background: async (
        space: Space,
        input: BackgroundInput,
        options?: { mimeType?: string }
      ) => {
        await space.send(backgroundContent(input as never, options));
      },
      shareContactCard: async (space: Space) => {
        await space.send(nativeContactCardContent());
      },
    },
  },

  message: {
    schema: messageSchema,
  },

  messages: ({ client }) => localMessages(client),

  send: async ({ space, content, client }) =>
    handleLocalOnlySend(client, space.id, content),

  actions: {
    getMessage: async ({ client }, _space, messageId) =>
      localGetMessage(client, messageId),
    getMembers: async () =>
      unsupportedAction(
        "getMembers",
        "listing members requires remote iMessage"
      ),
    getAvatar: async () =>
      unsupportedAction(
        "getAvatar",
        "fetching group avatars requires remote iMessage"
      ),
    getDisplayName: async () =>
      unsupportedAction(
        "getDisplayName",
        "reading chat display names requires remote iMessage"
      ),
    getAttachment: async (): Promise<Attachment | undefined> =>
      unsupportedAction(
        "getAttachment",
        "fetching attachments by GUID requires remote iMessage"
      ),
  },
});
