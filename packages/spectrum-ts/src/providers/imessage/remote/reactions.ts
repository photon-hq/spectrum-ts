import {
  type AdvancedIMessage,
  chatGuid,
  messageGuid,
  Reaction,
} from "@photon-ai/advanced-imessage";
import {
  type Reaction as ReactionContent,
  reactionSchema,
} from "../../../content/reaction";
import type { MessageCache } from "../cache";
import type { IMessageMessage } from "../types";
import { parseTapbackTarget } from "./ids";
import {
  buildMessageBase,
  cacheMessage,
  isIMessageMessage,
  type ReceivedEvent,
  rebuildFromAppleMessage,
} from "./inbound";

// Emoji ↔ classic tapback (Apple's six fixed reactions). On send, these six
// emoji use the native tapback API; anything else falls through to the
// emoji-reaction API (iOS 17+). On receive, classic tapbacks surface as
// their emoji equivalent so callers never see platform-specific strings.
const EMOJI_TO_TAPBACK: Readonly<Record<string, Reaction>> = {
  "❤️": Reaction.love,
  "👍": Reaction.like,
  "👎": Reaction.dislike,
  "😂": Reaction.laugh,
  "‼️": Reaction.emphasize,
  "❓": Reaction.question,
};

const TAPBACK_TO_EMOJI: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EMOJI_TO_TAPBACK).map(([emoji, kind]) => [kind, emoji])
);

// Apple `associatedMessageType` raw codes (IMItemType):
//   2000–2005 add classic tapback, 2006 add emoji, 2007 add sticker.
//   3000–3007 mirror but remove the reaction; we drop removals for now.
const TAPBACK_CODE_TO_KIND: Readonly<Record<string, Reaction>> = {
  "2000": Reaction.love,
  "2001": Reaction.like,
  "2002": Reaction.dislike,
  "2003": Reaction.laugh,
  "2004": Reaction.emphasize,
  "2005": Reaction.question,
  "2006": Reaction.emoji,
  "2007": Reaction.sticker,
};

const isTapbackRemoval = (code: string): boolean => code.startsWith("3");

const resolveReactionEmoji = (
  type: string | undefined,
  emoji: string | undefined
): string | null => {
  if (emoji) {
    return emoji;
  }
  if (!type) {
    return null;
  }
  const kind = TAPBACK_CODE_TO_KIND[type] ?? (type as Reaction);
  return TAPBACK_TO_EMOJI[kind] ?? null;
};

const getAssociatedMessageType = (
  message: ReceivedEvent["message"]
): string | undefined => {
  const direct = (message as { associatedMessageType?: unknown })
    .associatedMessageType;
  if (typeof direct === "string") {
    return direct;
  }
  const raw = (message as { _raw?: { associatedMessageType?: unknown } })._raw;
  const fromRaw = raw?.associatedMessageType;
  return typeof fromRaw === "string" ? fromRaw : undefined;
};

type RawProviderMessage = Pick<IMessageMessage, "content" | "id">;

const asProviderReaction = (
  emoji: string,
  target: RawProviderMessage
): ReactionContent =>
  reactionSchema.parse({
    emoji,
    target,
    type: "reaction",
  });

const resolveReactionTarget = async (
  client: AdvancedIMessage,
  cache: MessageCache,
  strippedGuid: string,
  partIndex: number
): Promise<IMessageMessage | undefined> => {
  let candidate = cache.get(strippedGuid);
  if (!candidate) {
    try {
      const fetched = await client.messages.get(messageGuid(strippedGuid));
      candidate = await rebuildFromAppleMessage(client, fetched);
      cacheMessage(cache, candidate);
    } catch {
      return;
    }
  }
  if (candidate.content.type === "group") {
    const items = candidate.content.items;
    if (!Array.isArray(items)) {
      return candidate;
    }
    const item = items[partIndex];
    return isIMessageMessage(item) ? item : candidate;
  }
  return candidate;
};

export const toReactionMessages = async (
  client: AdvancedIMessage,
  cache: MessageCache,
  event: ReceivedEvent,
  target: string
): Promise<IMessageMessage[]> => {
  const type = getAssociatedMessageType(event.message);
  if (type && isTapbackRemoval(type)) {
    return [];
  }
  const emoji = resolveReactionEmoji(
    type,
    event.message.associatedMessageEmoji
  );
  if (!emoji) {
    return [];
  }
  const { guid: strippedGuid, partIndex } = parseTapbackTarget(target);
  const resolved = await resolveReactionTarget(
    client,
    cache,
    strippedGuid,
    partIndex
  );
  if (!resolved) {
    return [];
  }
  const messageId = event.message.guid;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return [];
  }
  const base = buildMessageBase(event.message, event.chatGuid, event.timestamp);
  return [
    {
      ...base,
      id: messageId,
      content: asProviderReaction(emoji, resolved),
    },
  ];
};

export const reactToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<void> => {
  const chat = chatGuid(spaceId);
  // A group sub-item carries the parent's guid in `parentId`; top-level
  // messages reuse their own id. Apple's tapback API keys off the parent
  // guid and disambiguates via `partIndex`.
  const parentGuid = target.parentId ?? target.id;
  const guid = messageGuid(parentGuid);
  const opts =
    typeof target.partIndex === "number"
      ? { partIndex: target.partIndex }
      : undefined;

  const native = EMOJI_TO_TAPBACK[reaction];
  if (native) {
    await remote.messages.react(chat, guid, native, opts);
  } else {
    await remote.messages.reactEmoji(chat, guid, reaction, opts);
  }
};
