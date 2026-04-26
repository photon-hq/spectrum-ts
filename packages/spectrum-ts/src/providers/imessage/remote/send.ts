import {
  type AdvancedIMessage,
  type AttachmentGuid,
  chatGuid,
  type MessagePart,
  messageGuid,
  type SendOptions,
} from "@photon-ai/advanced-imessage";
import { asGroup } from "../../../content/group";
import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { Message } from "../../../types/message";
import { ensureM4a } from "../../../utils/audio";
import { toVCard } from "../../../utils/vcard";
import { unsupportedRemoteContent } from "../shared/errors";
import { vcardFileName } from "../shared/vcard";
import type { IMessageMessage } from "../types";
import { formatChildId } from "./ids";

const GROUP_ITEM_ALLOWED: ReadonlySet<Content["type"]> = new Set([
  "text",
  "attachment",
  "contact",
  "voice",
]);
const MAX_GROUP_TEXT_ITEMS = 1;

type ChatGuid = ReturnType<typeof chatGuid>;
type ReplyGuid = ReturnType<typeof messageGuid>;

interface SendReceiptLike {
  date?: unknown;
  dateCreated?: unknown;
  guid: unknown;
  timestamp?: unknown;
}

const toDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
};

const receiptTimestamp = (receipt: SendReceiptLike): Date =>
  toDate(receipt.timestamp) ??
  toDate(receipt.date) ??
  toDate(receipt.dateCreated) ??
  new Date();

const receiptGuid = (receipt: SendReceiptLike): string => {
  if (typeof receipt.guid !== "string" || receipt.guid.length === 0) {
    throw new Error("iMessage send receipt is missing a message guid");
  }
  return receipt.guid;
};

const outboundRecord = (
  spaceId: string,
  id: string,
  content: Content,
  timestamp: Date,
  extras?: Pick<IMessageMessage, "partIndex" | "parentId">
): ProviderMessageRecord => ({
  id,
  content,
  space: { id: spaceId },
  timestamp,
  ...extras,
});

const withReply = (
  options: SendOptions,
  replyTo: ReplyGuid | undefined
): SendOptions => (replyTo ? { ...options, replyTo } : options);

const replyOptions = (
  replyTo: ReplyGuid | undefined
): SendOptions | undefined => (replyTo ? { replyTo } : undefined);

const sendVCardAttachment = (
  remote: AdvancedIMessage,
  name: string,
  vcf: string
) =>
  remote.attachments.upload({
    data: Buffer.from(vcf, "utf8"),
    fileName: name,
    mimeType: "text/vcard",
  });

const sendContactAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "contact" }>
): Promise<{ guid: AttachmentGuid; name: string }> => {
  const vcf = await toVCard(content);
  const name = vcardFileName(content);
  const upload = await sendVCardAttachment(remote, name, vcf);
  return { guid: upload.guid, name };
};

const uploadAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "attachment" }>
): Promise<{ guid: AttachmentGuid; name: string }> => {
  const attachment = await remote.attachments.upload({
    data: await content.read(),
    fileName: content.name,
    mimeType: content.mimeType,
  });
  return { guid: attachment.guid, name: content.name };
};

const uploadVoice = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "voice" }>
): Promise<{ guid: AttachmentGuid; name: string }> => {
  const { buffer } = await ensureM4a(await content.read(), content.mimeType);
  const name = content.name ?? "voice.m4a";
  const attachment = await remote.attachments.upload({
    data: buffer,
    fileName: name,
    mimeType: "audio/x-m4a",
  });
  return { guid: attachment.guid, name };
};

const sendContent = async (
  remote: AdvancedIMessage,
  spaceId: string,
  chat: ChatGuid,
  content: Content,
  replyTo?: ReplyGuid
): Promise<ProviderMessageRecord> => {
  switch (content.type) {
    case "text": {
      const receipt = await remote.messages.send(
        chat,
        content.text,
        withReply({}, replyTo)
      );
      return outboundRecord(
        spaceId,
        receiptGuid(receipt),
        content,
        receiptTimestamp(receipt)
      );
    }
    case "richlink": {
      const receipt = await remote.messages.send(
        chat,
        content.url,
        withReply({ richLink: true }, replyTo)
      );
      return outboundRecord(
        spaceId,
        receiptGuid(receipt),
        content,
        receiptTimestamp(receipt)
      );
    }
    case "attachment": {
      const { guid } = await uploadAttachment(remote, content);
      const receipt = await remote.messages.send(chat, "", {
        attachment: guid,
        ...replyOptions(replyTo),
      });
      return outboundRecord(
        spaceId,
        receiptGuid(receipt),
        content,
        receiptTimestamp(receipt)
      );
    }
    case "contact": {
      const { guid } = await sendContactAttachment(remote, content);
      const receipt = await remote.messages.send(chat, "", {
        attachment: guid,
        ...replyOptions(replyTo),
      });
      return outboundRecord(
        spaceId,
        receiptGuid(receipt),
        content,
        receiptTimestamp(receipt)
      );
    }
    case "voice": {
      const { guid } = await uploadVoice(remote, content);
      const receipt = await remote.messages.send(chat, "", {
        attachment: guid,
        audioMessage: true,
        ...replyOptions(replyTo),
      });
      return outboundRecord(
        spaceId,
        receiptGuid(receipt),
        content,
        receiptTimestamp(receipt)
      );
    }
    case "poll":
      if (replyTo) {
        throw unsupportedRemoteContent(
          "poll",
          "polls cannot be sent as replies"
        );
      }
      return outboundRecord(
        spaceId,
        receiptGuid(
          await remote.polls.create(
            chat,
            content.title,
            content.options.map((option) => option.title)
          )
        ),
        content,
        new Date()
      );
    default:
      throw unsupportedRemoteContent(content.type);
  }
};

export const validateGroupContent = (
  content: Extract<Content, { type: "group" }>
): void => {
  // Strict validation: fail before any upload when a group contains items
  // iMessage cannot carry inside a multi-part message.
  let textCount = 0;
  for (const sub of content.items) {
    const itemType = sub.content.type;
    if (!GROUP_ITEM_ALLOWED.has(itemType)) {
      throw unsupportedRemoteContent(
        "group",
        `"${itemType}" items are not supported inside a group`
      );
    }
    if (itemType === "text" && ++textCount > MAX_GROUP_TEXT_ITEMS) {
      throw unsupportedRemoteContent(
        "group",
        `groups can contain at most ${MAX_GROUP_TEXT_ITEMS} text item`
      );
    }
  }
};

const resolvePart = async (
  remote: AdvancedIMessage,
  content: Content
): Promise<MessagePart> => {
  switch (content.type) {
    case "text":
      return { text: content.text };
    case "attachment": {
      const { guid, name } = await uploadAttachment(remote, content);
      return { attachmentGuid: guid, attachmentName: name };
    }
    case "contact": {
      const { guid, name } = await sendContactAttachment(remote, content);
      return { attachmentGuid: guid, attachmentName: name };
    }
    case "voice": {
      // As a sendMultipart part, voice loses the audio-bubble UI and renders
      // as a regular audio attachment. Send a single voice message (not in a
      // group) for the proper UI.
      const { guid, name } = await uploadVoice(remote, content);
      return { attachmentGuid: guid, attachmentName: name };
    }
    default:
      throw unsupportedRemoteContent(content.type);
  }
};

/**
 * Sends iMessage content. Group sends compose a single atomic multi-part
 * message via `sendMultipart`: one parent guid covers all parts, and per-part
 * operations (reactions, replies) key off `partIndex` against that parent.
 */
export const send = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const chat = chatGuid(spaceId);

  if (content.type === "group") {
    validateGroupContent(content);

    const resolved = await Promise.all(
      content.items.map((sub) => resolvePart(remote, sub.content))
    );
    const receipt = await remote.messages.sendMultipart(
      chat,
      resolved.map((part, idx) => ({ ...part, partIndex: idx }))
    );
    const parentGuid = receiptGuid(receipt);
    const timestamp = receiptTimestamp(receipt);

    const items = content.items.map((sub, idx) =>
      outboundRecord(
        spaceId,
        formatChildId(idx, parentGuid),
        sub.content,
        timestamp,
        { partIndex: idx, parentId: parentGuid }
      )
    );
    // Items are raw provider records — wrapProviderMessage("outbound") will
    // turn each into a real OutboundMessage via wrapNestedContent. The Zod
    // schema's `isMessage` guard is loose enough to accept the raw shape.
    return outboundRecord(
      spaceId,
      parentGuid,
      asGroup({ items: items as unknown as Message[] }),
      timestamp
    );
  }

  return sendContent(remote, spaceId, chat, content);
};

export const replyToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const chat = chatGuid(spaceId);
  const replyTo = messageGuid(msgId);
  return sendContent(remote, spaceId, chat, content, replyTo);
};

export const editMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content
): Promise<void> => {
  if (content.type !== "text") {
    throw unsupportedRemoteContent(
      content.type,
      "only text content can be edited"
    );
  }
  await remote.messages.edit(
    chatGuid(spaceId),
    messageGuid(msgId),
    content.text
  );
};
