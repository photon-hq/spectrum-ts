import { setTimeout as sleep } from "node:timers/promises";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import { type Group, groupSchema } from "../../../content/group";
import { asText } from "../../../content/text";
import { type ManagedStream, stream } from "../../../utils/stream";
import type { IMessageMessage } from "../types";
import { type LocalAttachment, localAttachmentContent } from "./attachments";

const ATTACHMENT_PLACEHOLDER = "\uFFFC";
const ATTACHMENT_JOIN_RETRY_DELAY_MS = 250;
const ATTACHMENT_JOIN_RETRY_LIMIT = 8;
const ATTACHMENT_JOIN_FETCH_LIMIT = 10;

type LocalMessageBase = Omit<IMessageMessage, "content" | "id">;
type RawProviderMessage = Pick<IMessageMessage, "content" | "id">;

const hasAttachmentPlaceholder = (message: LocalIMessage): boolean =>
  message.text?.includes(ATTACHMENT_PLACEHOLDER) ?? false;

const textWithoutAttachmentPlaceholder = (
  message: LocalIMessage
): string | undefined => {
  const text = message.text?.replaceAll(ATTACHMENT_PLACEHOLDER, "").trim();
  return text ? text : undefined;
};

const asProviderGroup = (items: readonly RawProviderMessage[]): Group =>
  groupSchema.parse({ type: "group", items });

const textMessage = (
  base: LocalMessageBase,
  parentId: string,
  text: string
): IMessageMessage => ({
  ...base,
  id: `${parentId}:text`,
  content: asText(text),
  parentId,
  partIndex: 0,
});

const attachmentMessage = async (
  base: LocalMessageBase,
  messageId: string,
  attachment: LocalAttachment,
  groupPart?: { parentId: string; partIndex: number }
): Promise<IMessageMessage> => ({
  ...base,
  id: `${messageId}:${attachment.id}`,
  content: await localAttachmentContent(attachment),
  ...(groupPart ?? {}),
});

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
    sender: { id: message.participant ?? "" },
    // Local mode has no concept of "which-of-my-phones"; phone is empty.
    space: {
      id: chatId,
      type: chatKind === "group" ? "group" : "dm",
      phone: "",
    },
    timestamp: message.createdAt,
  };

  if (message.attachments.length > 0) {
    const text = textWithoutAttachmentPlaceholder(message);
    const textOffset = text ? 1 : 0;
    const attachments = await Promise.all(
      message.attachments.map((att, index) =>
        attachmentMessage(
          base,
          message.id,
          att,
          message.attachments.length > 1 || text
            ? { parentId: message.id, partIndex: index + textOffset }
            : undefined
        )
      )
    );
    if (!text && attachments.length === 1) {
      return attachments;
    }
    const items = text
      ? [textMessage(base, message.id, text), ...attachments]
      : attachments;
    return [
      {
        ...base,
        id: message.id,
        content: asProviderGroup(items),
      },
    ];
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
