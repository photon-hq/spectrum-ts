import type {
  AdvancedIMessage,
  MessageEvent,
  SettableMessageReaction,
} from "@photon-ai/advanced-imessage";
import type { Reaction as ReactionContent } from "@spectrum-ts/core";
import {
  type ProviderMessageRecord,
  reactionSchema,
} from "@spectrum-ts/core/authoring";
import type { MessageCache } from "../cache";
import type { IMessageMessage } from "../types";
import { chatTypeFromGuid, toChatGuid, toMessageGuid } from "./ids";
import {
  cacheMessage,
  isIMessageMessage,
  rebuildFromAppleMessage,
  toSenderRef,
} from "./inbound";

type ReactionAddedEvent = Extract<
  MessageEvent,
  { type: "message.reactionAdded" }
>;

type TapbackKind = Exclude<SettableMessageReaction["kind"], "emoji">;

const EMOJI_TO_TAPBACK: Readonly<Record<string, TapbackKind>> = {
  "❤️": "love",
  "👍": "like",
  "👎": "dislike",
  "😂": "laugh",
  "‼️": "emphasize",
  "❓": "question",
};

const TAPBACK_TO_EMOJI: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EMOJI_TO_TAPBACK).map(([emoji, kind]) => [kind, emoji])
);

type RawProviderMessage = Pick<IMessageMessage, "content" | "id">;

const reactionEmoji = (
  reaction: ReactionAddedEvent["reaction"]
): string | undefined =>
  reaction.kind === "emoji" ? reaction.emoji : TAPBACK_TO_EMOJI[reaction.kind];

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
  chat: string,
  targetGuid: string,
  partIndex: number | undefined,
  phone: string
): Promise<IMessageMessage | undefined> => {
  let candidate = cache.get(targetGuid);
  if (!candidate) {
    try {
      const fetched = await client.messages.get(toMessageGuid(targetGuid));
      candidate = await rebuildFromAppleMessage(client, fetched, phone, chat);
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
    const item = items[partIndex ?? 0];
    return isIMessageMessage(item) ? item : candidate;
  }
  return candidate;
};

export const toReactionMessages = async (
  client: AdvancedIMessage,
  cache: MessageCache,
  event: ReactionAddedEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  const emoji = reactionEmoji(event.reaction);
  if (!emoji) {
    return [];
  }
  if (!event.actor?.address) {
    return [];
  }
  const resolved = await resolveReactionTarget(
    client,
    cache,
    event.chatGuid,
    event.messageGuid,
    event.targetPartIndex,
    phone
  );
  if (!resolved) {
    return [];
  }

  const partSuffix =
    typeof event.targetPartIndex === "number"
      ? `:${event.targetPartIndex}`
      : "";

  return [
    {
      sender: toSenderRef(event.actor),
      space: {
        id: event.chatGuid,
        type: chatTypeFromGuid(event.chatGuid),
        phone,
      },
      timestamp: event.occurredAt,
      id: `${event.messageGuid}:reaction:${event.sequence}${partSuffix}`,
      content: asProviderReaction(emoji, resolved),
    },
  ];
};

// Map a spectrum emoji onto the SDK reaction payload: native tapbacks keep
// their kind, anything else goes through Apple's custom-emoji reaction.
const toSettableReaction = (emoji: string): SettableMessageReaction => {
  const native = EMOJI_TO_TAPBACK[emoji];
  return native ? { kind: native } : { kind: "emoji", emoji };
};

// Tapbacks address the *original* message (parent guid + part index for
// group children), both when set and when removed.
const tapbackTarget = (
  target: IMessageMessage
): { guid: string; opts: { partIndex: number } | undefined } => ({
  guid: toMessageGuid(target.parentId ?? target.id),
  opts:
    typeof target.partIndex === "number"
      ? { partIndex: target.partIndex }
      : undefined,
});

export const reactToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<ProviderMessageRecord> => {
  const { guid, opts } = tapbackTarget(target);
  const sent = await remote.messages.setReaction(
    toChatGuid(spaceId),
    guid,
    toSettableReaction(reaction),
    true,
    opts
  );

  // `sent` is the real tapback message — its guid gives the reaction Message
  // a durable identity. `unsendReaction` re-derives the original target and
  // emoji from the reaction content instead of using this guid, because
  // Apple removes tapbacks via `setReaction(..., false)`, not by retracting
  // the tapback message itself.
  return {
    id: sent.guid,
    content: asProviderReaction(reaction, target),
    direction: "outbound",
    space: { id: spaceId },
    timestamp: sent.dateCreated,
  };
};

export const unsendReaction = async (
  remote: AdvancedIMessage,
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<void> => {
  const { guid, opts } = tapbackTarget(target);
  await remote.messages.setReaction(
    toChatGuid(spaceId),
    guid,
    toSettableReaction(reaction),
    false,
    opts
  );
};
