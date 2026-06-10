import type {
  AdvancedIMessage,
  MessageEvent,
  SettableMessageReaction,
} from "@photon-ai/advanced-imessage";
import {
  type Reaction as ReactionContent,
  reactionSchema,
} from "../../../content/reaction";
import type { MessageCache } from "../cache";
import type { IMessageMessage } from "../types";
import { chatTypeFromGuid, toChatGuid, toMessageGuid } from "./ids";
import {
  cacheMessage,
  isIMessageMessage,
  rebuildFromAppleMessage,
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
  const senderAddress = event.actor?.address;
  if (!senderAddress) {
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
      sender: { id: senderAddress },
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

export const reactToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<void> => {
  const chat = toChatGuid(spaceId);
  const parentGuid = target.parentId ?? target.id;
  const guid = toMessageGuid(parentGuid);
  const opts =
    typeof target.partIndex === "number"
      ? { partIndex: target.partIndex }
      : undefined;

  const native = EMOJI_TO_TAPBACK[reaction];
  if (native) {
    await remote.messages.setReaction(chat, guid, { kind: native }, true, opts);
  } else {
    await remote.messages.setReaction(
      chat,
      guid,
      { kind: "emoji", emoji: reaction },
      true,
      opts
    );
  }
};
