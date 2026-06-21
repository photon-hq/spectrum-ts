import {
  type AdvancedIMessage,
  createClient,
  MessageEffect,
} from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { withSpan } from "@photon-ai/otel";
import {
  type App,
  type Attachment,
  type Avatar,
  type Content,
  definePlatform,
  type Edit,
  type Rename,
  type Space,
  type StreamText,
  text,
  type Unsend,
  UnsupportedError,
} from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";

// `read` is universal framework content now (it was iMessage-only before
// 5.0.0). Re-exported here so existing imessage-scoped imports keep
// compiling — prefer importing from `spectrum-ts`.
// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export { read } from "@spectrum-ts/core";
export { type BackgroundInput, background } from "./content/background";
export { type ContactCard, nativeContactCard } from "./content/contact-card";
export {
  type CustomizedMiniApp,
  type CustomizedMiniAppInput,
  type CustomizedMiniAppLayout,
  customizedMiniApp,
} from "./content/customized-mini-app";
export { effect, type IMessageMessageEffect } from "./content/effect";

import { createCloudClients, disposeCloudAuth } from "./auth";
import { getMessageCache } from "./cache";
import {
  type Background,
  type BackgroundInput,
  background as backgroundContent,
  isBackground,
} from "./content/background";
import {
  isContactCard,
  nativeContactCard as nativeContactCardContent,
} from "./content/contact-card";
import {
  type CustomizedMiniApp,
  isCustomizedMiniApp,
} from "./content/customized-mini-app";
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
  shareContactCard as remoteShareContactCard,
  startTyping as remoteStartTyping,
  stopTyping as remoteStopTyping,
  unsendMessage as remoteUnsendMessage,
  unsendReaction as remoteUnsendReaction,
} from "./remote/api";
import { toSpectrumMiniApp } from "./remote/app";
import { getRemoteAttachment } from "./remote/attachments";
import {
  availablePhones,
  clientForPhone,
  isSharedMode,
  randomPhone,
} from "./remote/client";
import { chatTypeFromGuid, dmChatGuid } from "./remote/ids";
import { cacheMessage } from "./remote/inbound";
import {
  configSchema,
  type IMessageClient,
  type IMessageMessage,
  isLocal,
  messageSchema,
  SHARED_PHONE,
  spaceParamsSchema,
  spaceSchema,
  userSchema,
} from "./types";

const isPollContent = (content: { type: string }): boolean =>
  content.type === "poll" || content.type === "poll_option";

const cacheRemoteOutbound = <T extends ProviderMessageRecord | undefined>(
  remote: AdvancedIMessage,
  space: { id: string; phone: string; type: "dm" | "group" },
  record: T
): T => {
  if (!record) {
    return record;
  }
  cacheMessage(getMessageCache(remote), {
    ...record,
    direction: record.direction ?? "outbound",
    space: {
      ...record.space,
      id: record.space.id,
      phone: space.phone,
      type: space.type,
    },
  } as IMessageMessage);
  return record;
};

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

const handleUnsend = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: Unsend
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action("unsend", "iMessage (local mode)");
  }
  if (isPollContent(content.target.content)) {
    // The SDK has no poll delete; mirrors the reply/react poll guards.
    throw UnsupportedError.action(
      "unsend",
      "iMessage",
      "iMessage polls cannot be unsent"
    );
  }
  const remote = clientForPhone(client, space.phone);
  const targetContent = content.target.content;
  if (targetContent.type === "reaction") {
    // Tapbacks are removed via `setReaction(..., false)` against the
    // original message, not by retracting the tapback message — so pass
    // the reaction's own target (the message that was reacted to). Same
    // unknown-cast widen as the reaction send branch.
    await remoteUnsendReaction(
      remote,
      space.id,
      targetContent.target as unknown as IMessageMessage,
      targetContent.emoji
    );
    return;
  }
  await remoteUnsendMessage(remote, space.id, content.target.id);
};

const handleStreamText = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
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
  return cacheRemoteOutbound(
    remote,
    space,
    await remoteSendStreamText(remote, space.id, content)
  );
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
  space: { id: string; phone: string; type: "dm" | "group" },
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
  return cacheRemoteOutbound(
    remote,
    space,
    await remoteSendCustomizedMiniApp(remote, space.id, content)
  );
};

/**
 * Render the universal `app` content. On remote it becomes a native Spectrum
 * mini-app card (fixed `SPECTRUM_MINI_APP` identity + the URL + the layout
 * already parsed from the URL's link metadata). Local mode cannot send cards,
 * so it degrades to the bare URL as a text message.
 */
const handleApp = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: App
): Promise<ProviderMessageRecord> => {
  const url = await content.url();
  if (isLocal(client)) {
    return await localSend(client, space.id, await text(url).build());
  }
  const layout = await content.layout();
  const remote = clientForPhone(client, space.phone);
  return cacheRemoteOutbound(
    remote,
    space,
    await remoteSendCustomizedMiniApp(
      remote,
      space.id,
      toSpectrumMiniApp(url, layout)
    )
  );
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

const handleShareContactCard = async (
  client: IMessageClient,
  space: { id: string; phone: string }
): Promise<void> => {
  if (isLocal(client)) {
    throw UnsupportedError.action(
      "shareContactCard",
      "iMessage (local mode)",
      "sharing the contact card requires remote iMessage"
    );
  }
  const remote = clientForPhone(client, space.phone);
  await remoteShareContactCard(remote, space.id);
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

/**
 * Dispatch the iMessage-only fire-and-forget control signals that live outside
 * the universal `Content` union (`background`, `contactCard`). Each is narrowed
 * via a runtime guard rather than a `content.type ===` check — the literals
 * aren't members of `Content["type"]`. Returns `true` when it consumed the
 * content so `send` can return early, keeping its dispatch chain flat.
 */
const handleProviderControlSignal = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  content: Content
): Promise<boolean> => {
  if (isBackground(content)) {
    await handleBackground(client, space, content);
    return true;
  }
  if (isContactCard(content)) {
    await handleShareContactCard(client, space);
    return true;
  }
  return false;
};

/**
 * Resolve the remote client for a `reply` / `reaction` whose target is another
 * message. Both reject local mode and poll targets identically, so the guard
 * lives here to keep the `send` dispatch flat. `action` labels the error and
 * `pollNoun` is the plural used in the poll-unsupported message.
 */
const remoteForMessageTarget = (
  client: IMessageClient,
  space: { phone: string },
  target: { content: { type: string } },
  action: string,
  pollNoun: string
): AdvancedIMessage => {
  if (isLocal(client)) {
    throw UnsupportedError.action(action, "iMessage (local mode)");
  }
  if (isPollContent(target.content)) {
    throw UnsupportedError.action(
      action,
      "iMessage",
      `iMessage polls do not support ${pollNoun}`
    );
  }
  return clientForPhone(client, space.phone);
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
          "iMessage requires projectId and projectSecret. Either pass credentials to Spectrum(), use local mode: imessage.config({ local: true }), or provide explicit client config: imessage.config({ clients: [...] })"
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
    schema: userSchema,
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
          `iMessage space.get requires params.phone when multiple clients are configured. Available: ${availablePhones(client).join(", ")}`
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
      // Sugar: `space.shareContactCard()` → `space.send(nativeContactCard())`.
      // Routed through the universal send pipeline so the unsupported-content +
      // warn-and-skip path on local-mode iMessage is identical to the
      // canonical form. Shares the bot account's native contact card.
      shareContactCard: async (space: Space) => {
        await space.send(nativeContactCardContent());
      },
    },
  },

  message: {
    schema: messageSchema,
  },

  messages: ({ client, projectConfig }) =>
    isLocal(client)
      ? localMessages(client)
      : remoteMessages(client, projectConfig),

  send: async ({ space, content, client }) => {
    if (content.type === "reply") {
      const remote = remoteForMessageTarget(
        client,
        space,
        content.target,
        "reply",
        "replies"
      );
      return cacheRemoteOutbound(
        remote,
        space,
        await remoteReplyToMessage(
          remote,
          space.id,
          content.target.id,
          content.content
        )
      );
    }
    if (content.type === "reaction") {
      const remote = remoteForMessageTarget(
        client,
        space,
        content.target,
        "react",
        "reactions"
      );
      // `content.target` is statically typed as the generic `Message`, but
      // execution only reaches this iMessage `send` action when the target
      // came from the iMessage stream — hence the unknown-cast widen.
      return cacheRemoteOutbound(
        remote,
        space,
        await remoteReactToMessage(
          remote,
          space.id,
          content.target as unknown as IMessageMessage,
          content.emoji
        )
      );
    }
    if (content.type === "typing") {
      await handleTyping(client, space, content.state);
      return;
    }
    if (content.type === "edit") {
      await handleEdit(client, space, content);
      return;
    }
    if (content.type === "unsend") {
      await handleUnsend(client, space, content);
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
    if (content.type === "read") {
      // Chat-level granularity: `chats.markRead(chatGuid)` marks every
      // unread message in the chat — `content.target` only identifies the
      // chat, never a per-message cutoff.
      await handleRead(client, space);
      return;
    }
    if (content.type === "app") {
      return await handleApp(client, space, content);
    }
    // iMessage-only fire-and-forget signals (`background`, `contactCard`) that
    // live outside the universal `Content` union — see the helper.
    if (await handleProviderControlSignal(client, space, content)) {
      return;
    }
    // Also iMessage-only, but unlike the fire-and-forget signals above it
    // produces a real message — return the record rather than no id.
    if (isCustomizedMiniApp(content)) {
      return await handleCustomizedMiniApp(client, space, content);
    }
    if (isLocal(client)) {
      return await localSend(client, space.id, content);
    }
    const remote = clientForPhone(client, space.phone);
    return cacheRemoteOutbound(
      remote,
      space,
      await remoteSend(remote, space.id, content)
    );
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
