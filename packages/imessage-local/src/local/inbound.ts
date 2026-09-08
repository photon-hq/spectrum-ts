import { setTimeout as sleep } from "node:timers/promises";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import {
  type Content,
  type ManagedStream,
  type Message,
  stream,
} from "@spectrum-ts/core";
import {
  asCustom,
  asReaction,
  asReply,
  asText,
  type ProviderMessageRecord,
} from "@spectrum-ts/core/authoring";
import { appleAudioMimeType } from "../../../imessage/src/shared/audio";
import {
  ATTACHMENT_PLACEHOLDER,
  hasUsableTextPart,
  toOrderedParts,
} from "../../../imessage/src/shared/inbound-parts";
import type { IMessageMessage } from "../types";
import { localAttachmentContent } from "./attachments";
import { cacheLocalMessage, getLocalMessage } from "./lookup";

const ATTACHMENT_JOIN_RETRY_DELAY_MS = 250;
const ATTACHMENT_JOIN_RETRY_LIMIT = 8;
const ATTACHMENT_JOIN_FETCH_LIMIT = 10;

const TAPBACK_EMOJI: Readonly<Record<string, string>> = {
  dislike: "👎",
  emphasize: "‼️",
  laugh: "😂",
  like: "👍",
  love: "❤️",
  question: "❓",
};

const hasAttachmentPlaceholder = (message: LocalIMessage): boolean =>
  message.text?.includes(ATTACHMENT_PLACEHOLDER) ?? false;

const isPendingAttachmentJoin = (message: LocalIMessage): boolean =>
  message.attachments.length === 0 &&
  (message.hasAttachments || hasAttachmentPlaceholder(message));

const replyTargetId = (message: LocalIMessage): string | undefined =>
  message.threadRootMessageId ?? undefined;

const voiceAttachmentId = (message: LocalIMessage): string | undefined => {
  if (!message.isAudioMessage) {
    return;
  }
  return message.attachments.find((attachment) =>
    appleAudioMimeType(attachment)
  )?.id;
};

const stubReplyTarget = (
  space: IMessageMessage["space"],
  targetId: string
): ProviderMessageRecord => ({
  id: targetId,
  content: asCustom({ imessage_type: "reply-target", stub: true }),
  space,
});

const asProviderReply = (
  content: Content,
  target: ProviderMessageRecord
): Content =>
  asReply({
    content: content as Parameters<typeof asReply>[0]["content"],
    target: target as unknown as Parameters<typeof asReply>[0]["target"],
  });

const wrapReply = (
  messages: IMessageMessage[],
  targetId: string | undefined
): IMessageMessage[] => {
  if (!targetId) {
    return messages;
  }
  return messages.map((message) => ({
    ...message,
    content: asProviderReply(
      message.content,
      stubReplyTarget(message.space, targetId)
    ),
  }));
};

const messageBase = (
  message: LocalIMessage,
  chatId: string,
  chatKind: Exclude<LocalIMessage["chatKind"], "unknown">
): Omit<IMessageMessage, "id" | "content"> => ({
  direction: message.isFromMe ? "outbound" : "inbound",
  sender: {
    id: message.participant ?? "",
    ...(message.participant ? { address: message.participant } : {}),
    ...(message.service ? { service: message.service } : {}),
  },
  space: {
    id: chatId,
    type: chatKind === "group" ? "group" : "dm",
    phone: "",
  },
  timestamp: message.createdAt,
});

const stubReactionTarget = (
  base: Omit<IMessageMessage, "id" | "content">,
  targetId: string
): IMessageMessage => ({
  ...base,
  id: targetId,
  content: asCustom({ imessage_type: "reaction-target", stub: true }),
});

const reactionEmoji = (
  reaction: NonNullable<LocalIMessage["reaction"]>
): string | undefined =>
  reaction.kind === "emoji"
    ? (reaction.emoji ?? undefined)
    : TAPBACK_EMOJI[reaction.kind];

const toReactionMessage = async (
  client: IMessageSDK | undefined,
  message: LocalIMessage,
  base: Omit<IMessageMessage, "id" | "content">
): Promise<IMessageMessage | undefined> => {
  const reaction = message.reaction;
  if (!reaction?.targetMessageId) {
    return;
  }

  if (reaction.kind === "pollVote") {
    return {
      ...base,
      id: message.id,
      content: asCustom({
        imessage_type: "poll-vote",
        targetMessageId: reaction.targetMessageId,
      }),
    };
  }

  const emoji = reactionEmoji(reaction);
  if (!emoji) {
    return {
      ...base,
      id: message.id,
      content: asCustom({
        imessage_type: "reaction",
        kind: reaction.kind,
        removed: reaction.isRemoved,
        targetMessageId: reaction.targetMessageId,
      }),
    };
  }

  const target = client
    ? await getLocalMessage(client, base.space.id, reaction.targetMessageId)
    : undefined;
  return {
    ...base,
    id: message.id,
    content: asReaction({
      emoji,
      ...(reaction.isRemoved ? { removed: true } : {}),
      target: (target ??
        stubReactionTarget(
          base,
          reaction.targetMessageId
        )) as unknown as Message,
    }),
  };
};

const toGroupChangeMessage = (
  message: LocalIMessage,
  base: Omit<IMessageMessage, "id" | "content">
): IMessageMessage => ({
  ...base,
  id: message.id,
  content: asCustom({
    action: message.kind,
    affectedParticipant: message.affectedParticipant,
    imessage_type:
      message.kind === "unknown" ? "message-event" : "group-change",
    newGroupName: message.newGroupName,
  }),
});

const refetchUntilAttachmentsSettle = async (
  client: IMessageSDK,
  message: LocalIMessage
): Promise<LocalIMessage> => {
  if (!message.chatId) {
    return message;
  }

  for (let attempt = 0; attempt < ATTACHMENT_JOIN_RETRY_LIMIT; attempt += 1) {
    await sleep(ATTACHMENT_JOIN_RETRY_DELAY_MS);
    let rows: readonly LocalIMessage[];
    try {
      rows = await client.getMessages({
        chatId: message.chatId,
        limit: ATTACHMENT_JOIN_FETCH_LIMIT,
        since: message.createdAt,
      });
    } catch {
      continue;
    }
    const refreshed = rows.find((row) => row.id === message.id);
    if (refreshed && !isPendingAttachmentJoin(refreshed)) {
      return refreshed;
    }
  }

  return message;
};

export const toMessages = async (
  message: LocalIMessage,
  client?: IMessageSDK
): Promise<IMessageMessage[]> => {
  const { chatId, chatKind } = message;
  if (!chatId || chatKind === "unknown") {
    return [];
  }

  const base = messageBase(message, chatId, chatKind);

  if (message.reaction !== null) {
    const reaction = await toReactionMessage(client, message, base);
    return reaction ? [reaction] : [];
  }

  if (message.kind !== "text") {
    return [toGroupChangeMessage(message, base)];
  }

  if (message.retractedAt !== null) {
    return [];
  }

  if (isPendingAttachmentJoin(message)) {
    return [];
  }

  const targetId = replyTargetId(message);
  const audioAttachmentId = voiceAttachmentId(message);

  if (message.attachments.length > 0) {
    if (!hasUsableTextPart(message.text)) {
      const messages = await Promise.all(
        message.attachments.map(async (att) => ({
          ...base,
          id: `${message.id}:${att.id}`,
          content: await localAttachmentContent(
            att,
            att.id === audioAttachmentId
          ),
        }))
      );
      return wrapReply(messages, targetId);
    }

    const parts = toOrderedParts(message.text, message.attachments);
    const messages: IMessageMessage[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) {
        continue;
      }

      messages.push(
        part.type === "text"
          ? {
              ...base,
              id: `${message.id}:text:${i}`,
              content: asText(part.text),
              partIndex: i,
            }
          : {
              ...base,
              id: `${message.id}:${part.attachment.id}`,
              content: await localAttachmentContent(
                part.attachment,
                part.attachment.id === audioAttachmentId
              ),
              partIndex: i,
            }
      );
    }

    return wrapReply(messages, targetId);
  }

  return wrapReply(
    [
      {
        ...base,
        id: message.id,
        content: { type: "text", text: message.text ?? "" },
      },
    ],
    targetId
  );
};

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  stream((emit, end) => {
    let lastPromise: Promise<void> = Promise.resolve();

    const handleIncoming = async (message: LocalIMessage): Promise<void> => {
      const stableMessage = isPendingAttachmentJoin(message)
        ? await refetchUntilAttachmentsSettle(client, message)
        : message;
      const ms = await cacheLocalMessage(
        client,
        stableMessage,
        await toMessages(stableMessage, client)
      );
      for (const m of ms) {
        await emit(m);
      }
    };

    const startPromise = client
      .startWatching({
        onIncomingMessage: (message) => {
          lastPromise = lastPromise
            .then(() => handleIncoming(message))
            .catch(end);
        },
        onError: end,
      })
      .catch(end);

    return async () => {
      await startPromise.catch(() => {});
      await client.stopWatching();
      // The incoming callback is sync (returns undefined), so `stopWatching`
      // does not wait for the `lastPromise` chain: drain it explicitly to
      // avoid `emit`/attachment reads running past teardown.
      await lastPromise.catch(() => {});
    };
  });
