import {
  type AdvancedIMessage,
  createClient,
  type MiniAppCardSession,
} from "@photon-ai/advanced-imessage";
import { withSpan } from "@photon-ai/otel";
import {
  type AddMember,
  type App,
  type Attachment,
  type Avatar,
  type Content,
  definePlatform,
  type Edit,
  type RemoveMember,
  type Rename,
  type Space,
  type StreamText,
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
import { messageEffects } from "./content/effect";
import {
  addParticipants as remoteAddParticipants,
  editMessage as remoteEditMessage,
  getDisplayName as remoteGetDisplayName,
  getIcon as remoteGetIcon,
  getMessage as remoteGetMessage,
  leaveGroup as remoteLeaveGroup,
  listParticipants as remoteListParticipants,
  markRead as remoteMarkRead,
  messages as remoteMessages,
  reactToMessage as remoteReactToMessage,
  removeParticipants as remoteRemoveParticipants,
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
  updateCustomizedMiniApp as remoteUpdateCustomizedMiniApp,
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
  space: { id: string; phone: string; type: "dm" | "group" },
  content: Edit
): Promise<void> => {
  const miniAppCardSession = (
    content.target as unknown as { miniAppCardSession?: MiniAppCardSession }
  ).miniAppCardSession;
  const updateMiniAppCardSession = (
    record: ProviderMessageRecord | undefined
  ): void => {
    const nextSession = record?.miniAppCardSession;
    if (nextSession) {
      (
        content.target as unknown as {
          miniAppCardSession?: MiniAppCardSession;
        }
      ).miniAppCardSession = nextSession as MiniAppCardSession;
    }
  };
  if (content.content.type === "app") {
    if (!miniAppCardSession) {
      throw UnsupportedError.content(
        "edit",
        "iMessage",
        "mini app card edits require a miniAppCardSession from the original send"
      );
    }
    const url = await content.content.url();
    const layout = await content.content.layout();
    const remote = clientForPhone(client, space.phone);
    const record = cacheRemoteOutbound(
      remote,
      space,
      await remoteUpdateCustomizedMiniApp(
        remote,
        space.id,
        miniAppCardSession,
        toSpectrumMiniApp(url, layout, content.content.live)
      )
    );
    updateMiniAppCardSession(record);
    return;
  }
  if (isCustomizedMiniApp(content.content)) {
    if (!miniAppCardSession) {
      throw UnsupportedError.content(
        "edit",
        "iMessage",
        "customized mini app card edits require a miniAppCardSession from the original send"
      );
    }
    const remote = clientForPhone(client, space.phone);
    const record = cacheRemoteOutbound(
      remote,
      space,
      await remoteUpdateCustomizedMiniApp(
        remote,
        space.id,
        miniAppCardSession,
        content.content
      )
    );
    updateMiniAppCardSession(record);
    return;
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
  const remote = clientForPhone(client, space.phone);
  await remoteSetBackground(remote, space.id, content);
};

const handleCustomizedMiniApp = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: CustomizedMiniApp
): Promise<ProviderMessageRecord> => {
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
 * already parsed from the URL's link metadata).
 */
const handleApp = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: App
): Promise<ProviderMessageRecord> => {
  const url = await content.url();
  const layout = await content.layout();
  const remote = clientForPhone(client, space.phone);
  return cacheRemoteOutbound(
    remote,
    space,
    await remoteSendCustomizedMiniApp(
      remote,
      space.id,
      toSpectrumMiniApp(url, layout, content.live)
    )
  );
};

const handleRead = async (
  client: IMessageClient,
  space: { id: string; phone: string }
): Promise<void> => {
  const remote = clientForPhone(client, space.phone);
  await remoteMarkRead(remote, space.id);
};

const handleShareContactCard = async (
  client: IMessageClient,
  space: { id: string; phone: string }
): Promise<void> => {
  const remote = clientForPhone(client, space.phone);
  await remoteShareContactCard(remote, space.id);
};

const handleTyping = async (
  client: IMessageClient,
  space: { id: string; phone: string },
  state: "start" | "stop"
): Promise<void> => {
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
 * Shared guard for the membership handlers: remote-only, group-only, then
 * per-phone client resolution. Mirrors the `handleRename` / `handleAvatar`
 * guard sequence.
 */
const remoteGroupClient = (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  action: string,
  detail: string
): AdvancedIMessage => {
  if (space.type !== "group") {
    throw UnsupportedError.action(action, "iMessage", detail);
  }
  return clientForPhone(client, space.phone);
};

const handleAddMember = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: AddMember
): Promise<void> => {
  const remote = remoteGroupClient(
    client,
    space,
    "addMember",
    "only group chats can add members (this space is a DM — iMessage cannot convert a DM into a group; create a group via space.create instead)"
  );
  await remoteAddParticipants(remote, space.id, content);
};

const handleRemoveMember = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" },
  content: RemoveMember
): Promise<void> => {
  const remote = remoteGroupClient(
    client,
    space,
    "removeMember",
    "only group chats can remove members (this space is a DM — iMessage cannot convert a DM into a group; create a group via space.create instead)"
  );
  await remoteRemoveParticipants(remote, space.id, content);
};

const handleLeaveSpace = async (
  client: IMessageClient,
  space: { id: string; phone: string; type: "dm" | "group" }
): Promise<void> => {
  const remote = remoteGroupClient(
    client,
    space,
    "leaveSpace",
    "only group chats can be left (this space is a DM)"
  );
  await remoteLeaveGroup(remote, space.id);
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
 * message. `action` labels the error and `pollNoun` is the plural used in the
 * poll-unsupported message.
 */
const remoteForMessageTarget = (
  client: IMessageClient,
  space: { phone: string },
  target: { content: { type: string } },
  action: string,
  pollNoun: string
): AdvancedIMessage => {
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
      message: messageEffects,
    },
  },

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<IMessageClient> => {
      if (config.clients) {
        const entries = Array.isArray(config.clients)
          ? config.clients
          : [config.clients];
        return entries.map((e) => ({
          phone: e.phone,
          client: createClient({
            address: e.address,
            // Auto-retry transient unary failures (idempotency-keyed so retries
            // can't double-apply) so a server blip during an outbound action
            // doesn't crash the app.
            autoIdempotency: true,
            retry: true,
            tls: true,
            token: e.token,
          }),
        }));
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "Cloud iMessage requires projectId and projectSecret. Pass credentials to Spectrum() or provide explicit clients with imessage.config({ clients: [...] }). For local Messages access, install @spectrum-ts/imessage-local and use its imessage.config()."
        );
      }

      return await createCloudClients(projectId, projectSecret);
    },

    destroyClient: async ({ client }) => {
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
      // send pipeline so the canonical and sugar forms share behavior.
      background: async (
        space: Space,
        input: BackgroundInput,
        opts?: { mimeType?: string }
      ) => {
        await space.send(backgroundContent(input as never, opts));
      },
      // Sugar: `space.shareContactCard()` → `space.send(nativeContactCard())`.
      // Routed through the universal send pipeline so the canonical and sugar
      // forms share behavior. Shares the bot account's native contact card.
      shareContactCard: async (space: Space) => {
        await space.send(nativeContactCardContent());
      },
    },
  },

  message: {
    schema: messageSchema,
  },

  messages: ({ client, projectConfig }) =>
    remoteMessages(client, projectConfig),

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
    if (content.type === "addMember") {
      await handleAddMember(client, space, content);
      return;
    }
    if (content.type === "removeMember") {
      await handleRemoveMember(client, space, content);
      return;
    }
    if (content.type === "leaveSpace") {
      await handleLeaveSpace(client, space);
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
    const remote = clientForPhone(client, space.phone);
    return cacheRemoteOutbound(
      remote,
      space,
      await remoteSend(remote, space.id, content)
    );
  },

  actions: {
    getMessage: async ({ client }, space, messageId) => {
      const remote = clientForPhone(client, space.phone);
      return remoteGetMessage(remote, space.id, messageId, space.phone);
    },
    // List a remote group chat's current participants. Remote + group only;
    // the agent's own number is excluded. `id` is the canonical address
    // (E.164 phone or email); `address`/`country`/`service` ride along per
    // `userSchema`.
    getMembers: async ({ client }, space) => {
      const remote = remoteGroupClient(
        client,
        space,
        "getMembers",
        "only group chats support listing members (this space is a DM)"
      );
      return await remoteListParticipants(remote, space.id, space.phone);
    },
    // Download the group chat's current icon; `undefined` when none is set.
    // Remote + group only — mirrors the avatar setter's guards.
    getAvatar: async ({ client }, space) => {
      const remote = remoteGroupClient(
        client,
        space,
        "getAvatar",
        "only group chats have avatars (this space is a DM)"
      );
      return await remoteGetIcon(remote, space.id);
    },
    // Read a group chat's title. Group-only, remote only — mirrors the other
    // group reads (`getAvatar`, `getMembers`) via `remoteGroupClient`.
    getDisplayName: async ({ client }, space) => {
      const remote = remoteGroupClient(
        client,
        space,
        "getDisplayName",
        "only group chats have display names (this space is a DM)"
      );
      return await remoteGetDisplayName(remote, space.id);
    },
    // Fetch an attachment by GUID. Returns a spectrum `Attachment` whose
    // `.read()` / `.stream()` lazily download the bytes — calling both
    // issues two independent gRPC downloads, so cache `.read()` if you
    // need the bytes more than once. Returns `undefined` for unknown
    // GUIDs.
    getAttachment: async (
      { client }: { client: IMessageClient },
      guid: string,
      phone?: string
    ): Promise<Attachment | undefined> => {
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
