import { setTimeout as sleep } from "node:timers/promises";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import { type ManagedStream, stream } from "@spectrum-ts/core";
import { asText } from "@spectrum-ts/core/authoring";
import {
  ATTACHMENT_PLACEHOLDER,
  hasUsableTextPart,
  toOrderedParts,
} from "../shared/inbound-parts";
import type { IMessageMessage } from "../types";
import { localAttachmentContent } from "./attachments";

const ATTACHMENT_JOIN_RETRY_DELAY_MS = 250;
const ATTACHMENT_JOIN_RETRY_LIMIT = 8;
const ATTACHMENT_JOIN_FETCH_LIMIT = 10;

const hasAttachmentPlaceholder = (message: LocalIMessage): boolean =>
  message.text?.includes(ATTACHMENT_PLACEHOLDER) ?? false;

const isPendingAttachmentJoin = (message: LocalIMessage): boolean =>
  message.attachments.length === 0 &&
  (message.hasAttachments || hasAttachmentPlaceholder(message));

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
  message: LocalIMessage
): Promise<IMessageMessage[]> => {
  const { chatId, chatKind } = message;
  if (!chatId || chatKind === "unknown") {
    return [];
  }

  // Drop rows spectrum's Content union cannot faithfully represent:
  // reactions, group events, and retracts would collapse to empty or
  // Apple-generated pseudo-text otherwise.
  if (
    message.reaction !== null ||
    message.kind !== "text" ||
    message.retractedAt !== null
  ) {
    return [];
  }

  if (isPendingAttachmentJoin(message)) {
    return [];
  }

  const base: Omit<IMessageMessage, "id" | "content"> = {
    // Local mode exposes only the participant address; no service/country.
    sender: {
      id: message.participant ?? "",
      ...(message.participant ? { address: message.participant } : {}),
    },
    // Local mode has no concept of "which-of-my-phones"; phone is empty.
    space: {
      id: chatId,
      type: chatKind === "group" ? "group" : "dm",
      phone: "",
    },
    timestamp: message.createdAt,
  };

  if (message.attachments.length > 0) {
    if (!hasUsableTextPart(message.text)) {
      return Promise.all(
        message.attachments.map(async (att) => ({
          ...base,
          id: `${message.id}:${att.id}`,
          content: await localAttachmentContent(att),
        }))
      );
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
              content: await localAttachmentContent(part.attachment),
              partIndex: i,
            }
      );
    }

    return messages;
  }

  return [
    {
      ...base,
      id: message.id,
      content: { type: "text", text: message.text ?? "" },
    },
  ];
};

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  stream((emit, end) => {
    let lastPromise: Promise<void> = Promise.resolve();

    const handleIncoming = async (message: LocalIMessage): Promise<void> => {
      const stableMessage = isPendingAttachmentJoin(message)
        ? await refetchUntilAttachmentsSettle(client, message)
        : message;
      const ms = await toMessages(stableMessage);
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
