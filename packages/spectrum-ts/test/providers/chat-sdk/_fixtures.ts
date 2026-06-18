// Shared fixtures for the chat-sdk provider tests. Now that the provider uses
// the real `chat` types, event/author literals must satisfy the real shapes —
// these helpers fill the required fields so each test only states what it cares
// about. (Not a `.test.ts` file, so the runner never executes it.)

import type { Author, EmojiValue, Logger } from "chat";
import type { ChatReactionEvent } from "@/providers/chat-sdk/types";

// Loggers are never invoked in these unit tests; a cast keeps fixtures terse.
export const noopLogger = {} as unknown as Logger;

/** A full `Author`, overridable per field (defaults to a non-bot human). */
export const author = (userId: string, over: Partial<Author> = {}): Author => ({
  userId,
  userName: userId,
  fullName: userId,
  isBot: false,
  isMe: false,
  ...over,
});

const emojiValue = (name: string): EmojiValue => ({
  name,
  toJSON: () => name,
  toString: () => name,
});

/** A full `ChatReactionEvent` from the fields a test supplies. */
export const reactionEvent = (
  over: Pick<
    ChatReactionEvent,
    "added" | "messageId" | "rawEmoji" | "threadId" | "user"
  > &
    Partial<ChatReactionEvent>
): ChatReactionEvent => ({
  emoji: emojiValue(over.rawEmoji),
  raw: {},
  ...over,
});
