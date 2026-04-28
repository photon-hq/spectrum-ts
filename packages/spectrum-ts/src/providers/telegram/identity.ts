// Shared sender / space mappers used by *both* the inbound update path
// (`events/inbound.ts`) and the outbound send path (`messages.ts`). These
// must produce byte-identical shapes on both sides — a message we send and
// a message we receive should round-trip through the cache with the same
// `sender` and `space` payloads — so we centralize them here rather than
// keeping parallel `userToSender` / `buildOutboundSender` and
// `chatToSender` / `buildChatSender` pairs that drift apart silently.
//
// This module is a leaf: it imports only generated types and the
// `TelegramMessage` shape, so both `messages.ts` and `events/inbound.ts`
// can pull from it without forming a cycle.

import type { Chat, Message, User } from "./generated/types";
import type { TelegramMessage } from "./types";

const chatIdToSpaceId = (chatId: number): string => String(chatId);
const userIdToSpectrumId = (userId: number): string => String(userId);

// `User` is the canonical shape for both inbound (`message.from`) and the
// bot-identity fallback (`runtime.me`). `NonNullable<Message["from"]>` is
// structurally identical to `User`, so callers on the outbound side can
// pass either without a cast.
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
// but with `sender_chat`. Synthesize a sender from the chat so:
//   - inbound: these updates are delivered end-to-end instead of silently
//     dropped.
//   - outbound: a channel post we send is cached as authored by the
//     channel, not by the bot account that issued the call. Otherwise
//     downstream consumers see the bot's user identity for a message
//     whose canonical author is the channel, and the round-trip identity
//     invariant breaks.
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

// Inline anonymous return type (rather than a named alias) so the result
// satisfies `ProviderMessageRecord["space"]`'s `Record<string, unknown>`
// index signature when it's used as a stub target — a named `interface`
// does not.
export const chatToSpace = (
  chat: Chat
): {
  chatId: number;
  id: string;
  title?: string;
  type: Chat["type"];
  username?: string;
} => {
  const space: {
    chatId: number;
    id: string;
    title?: string;
    type: Chat["type"];
    username?: string;
  } = {
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
