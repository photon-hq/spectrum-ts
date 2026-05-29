import type { Avatar, Content, Edit, Reaction, Voice } from "spectrum-ts";
import { UnsupportedError } from "spectrum-ts";
import type { ProviderMessageRecord } from "spectrum-ts/authoring";
import { getClient, type LinqClient, type StoreLike } from "../client";
import { LINQ_PLATFORM, type LinqConfig } from "../config";
import { emojiToReaction } from "../reactions";
import { decodePending, type LinqSpace } from "../space";
import type { LinqOutboundMessage } from "../types";
import { buildMessage } from "./message";

const CHAT_CACHE_PREFIX = "linq:chat:";
const DEFAULT_VOICE_FILENAME = "voice-memo.m4a";
const GROUP_ICON_FILENAME = "group-icon";

interface SendArgs {
  config: LinqConfig;
  content: Content;
  space: LinqSpace;
  store: StoreLike;
}

const requireExistingChat = (space: LinqSpace, action: string): string => {
  if (decodePending(space.id)) {
    throw UnsupportedError.action(
      action,
      LINQ_PLATFORM,
      "send a message first to create the chat before performing this action."
    );
  }
  return space.id;
};

const sendReaction = async (
  client: LinqClient,
  content: Reaction
): Promise<undefined> => {
  const { type, customEmoji } = emojiToReaction(content.emoji);
  await client.addReaction(content.target.id, {
    operation: "add",
    type,
    ...(customEmoji ? { customEmoji } : {}),
  });
  return;
};

const sendTyping = async (
  client: LinqClient,
  space: LinqSpace,
  state: "start" | "stop"
): Promise<undefined> => {
  const chatId = requireExistingChat(space, "typing");
  if (state === "start") {
    await client.startTyping(chatId);
  } else {
    await client.stopTyping(chatId);
  }
  return;
};

const sendRename = async (
  client: LinqClient,
  space: LinqSpace,
  displayName: string
): Promise<undefined> => {
  await client.updateChat(requireExistingChat(space, "rename"), {
    displayName,
  });
  return;
};

const sendAvatar = async (
  client: LinqClient,
  space: LinqSpace,
  content: Avatar
): Promise<undefined> => {
  const chatId = requireExistingChat(space, "avatar");
  if (content.action.kind === "clear") {
    await client.updateChat(chatId, { groupChatIcon: "" });
    return;
  }
  const { downloadUrl } = await client.uploadAttachment({
    filename: GROUP_ICON_FILENAME,
    contentType: content.action.mimeType,
    bytes: await content.action.read(),
  });
  await client.updateChat(chatId, { groupChatIcon: downloadUrl });
  return;
};

const sendEdit = async (
  client: LinqClient,
  content: Edit
): Promise<undefined> => {
  if (content.content.type !== "text") {
    throw UnsupportedError.content(
      "edit",
      LINQ_PLATFORM,
      `only text content can be edited (got "${content.content.type}").`
    );
  }
  await client.editMessage(content.target.id, { text: content.content.text });
  return;
};

const sendVoice = async (
  client: LinqClient,
  space: LinqSpace,
  content: Voice
): Promise<ProviderMessageRecord> => {
  const chatId = requireExistingChat(space, "voice");
  const { attachmentId } = await client.uploadAttachment({
    filename: content.name ?? DEFAULT_VOICE_FILENAME,
    contentType: content.mimeType,
    bytes: await content.read(),
  });
  const { voiceMemoId } = await client.sendVoicememo(chatId, { attachmentId });
  return {
    id: voiceMemoId,
    content,
    space: { id: chatId },
    timestamp: new Date(),
  };
};

const dispatchMessage = async (
  client: LinqClient,
  store: StoreLike,
  space: LinqSpace,
  message: LinqOutboundMessage
): Promise<{ chatId: string; messageId: string }> => {
  const pending = decodePending(space.id);
  if (!pending) {
    const { messageId } = await client.sendMessage(space.id, message);
    return { chatId: space.id, messageId };
  }
  const cacheKey = `${CHAT_CACHE_PREFIX}${space.id}`;
  const cached = store.get(cacheKey);
  if (typeof cached === "string") {
    const { messageId } = await client.sendMessage(cached, message);
    return { chatId: cached, messageId };
  }
  const created = await client.createChat({
    from: pending.from,
    to: pending.to,
    message,
  });
  store.set(cacheKey, created.chatId);
  return created;
};

const sendOutboundMessage = async (
  client: LinqClient,
  store: StoreLike,
  space: LinqSpace,
  content: Content
): Promise<ProviderMessageRecord> => {
  const built = await buildMessage(client, content);
  const message: LinqOutboundMessage = space.preferredService
    ? { ...built, preferredService: space.preferredService }
    : built;
  const { chatId, messageId } = await dispatchMessage(
    client,
    store,
    space,
    message
  );
  return {
    id: messageId,
    content,
    space: { id: chatId },
    timestamp: new Date(),
  };
};

/**
 * Outbound dispatcher. Fire-and-forget signals (reaction, typing, rename,
 * avatar, edit) return `undefined`; message-producing content returns a record
 * with the LinQ message id. `poll` is unsupported (LinQ has no polls).
 */
export const send = async ({
  space,
  content,
  config,
  store,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  const client = getClient(store, config);
  switch (content.type) {
    case "reaction":
      return await sendReaction(client, content);
    case "typing":
      return await sendTyping(client, space, content.state);
    case "rename":
      return await sendRename(client, space, content.displayName);
    case "avatar":
      return await sendAvatar(client, space, content);
    case "edit":
      return await sendEdit(client, content);
    case "voice":
      return await sendVoice(client, space, content);
    case "poll":
    case "poll_option":
      throw UnsupportedError.content(content.type, LINQ_PLATFORM);
    default:
      return await sendOutboundMessage(client, store, space, content);
  }
};
