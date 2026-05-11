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

// For channel posts and anonymous group-admin messages, `from` is absent
// and `sender_chat` carries the author.
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

// Must be `type`, not `interface`: callers assign into `Record<string, unknown>`
// slots which interfaces don't satisfy.
// biome-ignore lint/style/useConsistentTypeDefinitions: see comment above.
type TelegramSpaceShape = {
  chatId: number;
  id: string;
  title?: string;
  type: Chat["type"];
  username?: string;
};

// Private chats arrive without a `title`; synthesize a readable one
// from first_name + last_name so DM spaces still surface a usable name.
const privateChatTitle = (chat: Chat): string | undefined => {
  if (chat.type !== "private") {
    return;
  }
  const parts = [chat.first_name, chat.last_name].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (parts.length === 0) {
    return chat.username;
  }
  return parts.join(" ");
};

export const chatToSpace = (chat: Chat): TelegramSpaceShape => {
  const space: TelegramSpaceShape = {
    id: chatIdToSpaceId(chat.id),
    chatId: chat.id,
    type: chat.type,
  };
  const title = chat.title ?? privateChatTitle(chat);
  if (title !== undefined) {
    space.title = title;
  }
  if (chat.username !== undefined) {
    space.username = chat.username;
  }
  return space;
};
