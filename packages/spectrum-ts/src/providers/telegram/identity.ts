// Shared sender / space mappers used by both inbound and outbound paths
// so a sent message and a received message round-trip through the cache
// with byte-identical `sender` and `space` shapes.

import type { Chat, Message, User } from "./generated/types";
import type { TelegramMessage } from "./types";

const chatIdToSpaceId = (chatId: number): string => String(chatId);
const userIdToSpectrumId = (userId: number): string => String(userId);

export const userToSender = (user: User): TelegramMessage["sender"] => {
  const sender: TelegramMessage["sender"] = {
    id: userIdToSpectrumId(user.id),
    chatId: user.id,
    isBot: user.is_bot,
    firstName: user.first_name,
  };
  if (user.last_name !== undefined) {
    sender.lastName = user.last_name;
  }
  if (user.username !== undefined) {
    sender.username = user.username;
  }
  if (user.language_code !== undefined) {
    sender.languageCode = user.language_code;
  }
  return sender;
};

// Channel posts and anonymous group-admin messages arrive without `from`
// but with `sender_chat`; synthesize the sender from the chat so the
// canonical author is the channel on both sides of the round-trip.
export const chatToSender = (
  chat: NonNullable<Message["sender_chat"]> | Chat
): TelegramMessage["sender"] => {
  const sender: TelegramMessage["sender"] = {
    id: chatIdToSpaceId(chat.id),
    chatId: chat.id,
    isBot: false,
    firstName: chat.title ?? chat.username ?? "Telegram chat",
  };
  if (chat.username !== undefined) {
    sender.username = chat.username;
  }
  return sender;
};

// Must remain a `type` alias rather than an `interface`: consumers assign
// the result to `Record<string, unknown>` slots, which TS rejects from an
// open-extension `interface` declaration but accepts from a closed `type`.
// biome-ignore lint/style/useConsistentTypeDefinitions: see comment above.
type TelegramSpaceShape = {
  chatId: number;
  id: string;
  title?: string;
  type: Chat["type"];
  username?: string;
};

export const chatToSpace = (chat: Chat): TelegramSpaceShape => {
  const space: TelegramSpaceShape = {
    id: chatIdToSpaceId(chat.id),
    chatId: chat.id,
    type: chat.type,
  };
  if (chat.title !== undefined) {
    space.title = chat.title;
  }
  if (chat.username !== undefined) {
    space.username = chat.username;
  }
  return space;
};
