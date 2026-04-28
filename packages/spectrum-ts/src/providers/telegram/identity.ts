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

// Named shape used both as the return type and the local builder variable
// type to dedupe the inline anonymous shape that previously appeared twice.
//
// Why `type` instead of `interface` (and the matching biome-ignore):
// `chatToSpace`'s result is consumed by `events/reactions.ts` as a stub
// target for `ProviderMessageRecord["space"]`, whose schema-level type
// extends `Record<string, unknown>`. TS treats `interface` declarations
// as potentially extensible and therefore *not* assignable to a closed
// index signature like `Record<string, unknown>`, while a `type` alias
// is structurally closed and is assignable. We verified this empirically
// — switching to `interface` produces:
//   reactions.ts(73,3): TS2322 — Type ... is not assignable to type
//   '{ id: string; } & Record<string, unknown>'.
// So we keep `type` here and disable `useConsistentTypeDefinitions` for
// this single declaration.
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
