import {
  type AdvancedIMessage,
  type AttachmentGuid,
  chatGuid,
  type MessagePart,
  messageGuid,
  type SendOptions,
} from "@photon-ai/advanced-imessage";
import type { Content } from "../../../content/types";
import type { SendResult } from "../../../platform/types";
import { ensureM4a } from "../../../utils/audio";
import { toVCard } from "../../../utils/vcard";
import { unsupportedRemoteContent } from "../shared/errors";
import { vcardFileName } from "../shared/vcard";
import type { IMessageMessage } from "../types";
import { formatChildId, parseChildId } from "./ids";

const MIN_GROUP_ITEMS = 2;
const MAX_GROUP_TEXT_ITEMS = 1;

type ChatGuid = ReturnType<typeof chatGuid>;
type ReplyTarget = NonNullable<SendOptions["replyTo"]>;

export interface SendOptionsInternal {
  nativeMultipartGroups?: boolean;
}

interface SendReceiptLike {
  date?: unknown;
  dateCreated?: unknown;
  guid: unknown;
  timestamp?: unknown;
}

export class PartialGroupSendError extends Error {
  override readonly cause: unknown;
  readonly groupMembers: readonly SendResult[];

  constructor(groupMembers: readonly SendResult[], cause: unknown) {
    super("iMessage group send failed after one or more items were sent");
    this.name = "PartialGroupSendError";
    this.cause = cause;
    this.groupMembers = groupMembers;
  }
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

const toSendResult = (receipt: SendReceiptLike): SendResult => {
  if (typeof receipt.guid !== "string" || receipt.guid.length === 0) {
    throw new Error("iMessage send receipt is missing a message guid");
  }
  return {
    id: receipt.guid,
    timestamp: receiptTimestamp(receipt),
  };
};

const withReply = (
  options: SendOptions,
  replyTo: ReplyTarget | undefined
): SendOptions => (replyTo ? { ...options, replyTo } : options);

const replyOptions = (
  replyTo: ReplyTarget | undefined
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
): Promise<AttachmentGuid> => {
  const vcf = await toVCard(content);
  const upload = await sendVCardAttachment(remote, vcardFileName(content), vcf);
  return upload.guid;
};

const uploadAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "attachment" }>
): Promise<AttachmentGuid> => {
  const attachment = await remote.attachments.upload({
    data: await content.read(),
    fileName: content.name,
    mimeType: content.mimeType,
  });
  return attachment.guid;
};

const uploadVoice = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "voice" }>
): Promise<AttachmentGuid> => {
  const { buffer } = await ensureM4a(await content.read(), content.mimeType);
  const attachment = await remote.attachments.upload({
    data: buffer,
    fileName: content.name ?? "voice.m4a",
    mimeType: "audio/x-m4a",
  });
  return attachment.guid;
};

const sendContent = async (
  remote: AdvancedIMessage,
  chat: ChatGuid,
  content: Content,
  replyTo?: ReplyTarget
): Promise<SendResult> => {
  switch (content.type) {
    case "text":
      return toSendResult(
        await remote.messages.send(chat, content.text, withReply({}, replyTo))
      );
    case "richlink":
      return toSendResult(
        await remote.messages.send(
          chat,
          content.url,
          withReply({ richLink: true }, replyTo)
        )
      );
    case "attachment":
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: await uploadAttachment(remote, content),
          ...replyOptions(replyTo),
        })
      );
    case "contact":
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: await sendContactAttachment(remote, content),
          ...replyOptions(replyTo),
        })
      );
    case "voice":
      return toSendResult(
        await remote.messages.send(chat, "", {
          attachment: await uploadVoice(remote, content),
          audioMessage: true,
          ...replyOptions(replyTo),
        })
      );
    case "poll":
      if (replyTo) {
        throw unsupportedRemoteContent(
          "poll",
          "polls cannot be sent as replies"
        );
      }
      return toSendResult(
        await remote.polls.create(
          chat,
          content.title,
          content.options.map((option) => option.title)
        )
      );
    default:
      throw unsupportedRemoteContent(content.type);
  }
};

export const validateGroupContent = (
  content: Extract<Content, { type: "group" }>
): void => {
  if (content.items.length < MIN_GROUP_ITEMS) {
    throw unsupportedRemoteContent(
      "group",
      `iMessage multipart groups require at least ${MIN_GROUP_ITEMS} items`
    );
  }

  let attachmentCount = 0;
  let textCount = 0;

  for (const sub of content.items) {
    switch (sub.content.type) {
      case "text":
        textCount += 1;
        break;
      case "attachment":
        attachmentCount += 1;
        break;
      default:
        throw unsupportedRemoteContent(
          "group",
          `iMessage multipart groups support only attachment items plus up to one text item; "${sub.content.type}" is not supported`
        );
    }
  }

  if (textCount > MAX_GROUP_TEXT_ITEMS) {
    throw unsupportedRemoteContent(
      "group",
      `iMessage multipart groups support at most ${MAX_GROUP_TEXT_ITEMS} text item`
    );
  }

  if (attachmentCount === 0) {
    throw unsupportedRemoteContent(
      "group",
      "iMessage multipart groups require at least one attachment"
    );
  }
};

export const toMultipartParts = (
  content: Extract<Content, { type: "group" }>
): MessagePart[] => {
  validateGroupContent(content);
  return content.items.map((sub, partIndex) => {
    if (sub.content.type === "text") {
      return { partIndex, text: sub.content.text };
    }
    if (sub.content.type === "attachment" && sub.content.path) {
      return {
        attachmentName: sub.content.name,
        attachmentPath: sub.content.path,
        partIndex,
      };
    }
    if (sub.content.type === "attachment") {
      throw unsupportedRemoteContent(
        "group",
        "iMessage multipart group attachments must be path-backed; use attachment('/path/to/file') instead of attachment(Buffer)"
      );
    }
    throw unsupportedRemoteContent("group", "invalid iMessage multipart item");
  });
};

const groupMembersForMultipart = (
  receipt: SendResult,
  memberCount: number
): SendResult[] => {
  const timestamp = receipt.timestamp ?? new Date();
  return Array.from({ length: memberCount }, (_, partIndex) => ({
    extras: { parentId: receipt.id, partIndex },
    id: formatChildId(partIndex, receipt.id),
    sender: receipt.sender,
    timestamp,
  }));
};

const sendGroupSequentially = async (
  remote: AdvancedIMessage,
  chat: ChatGuid,
  content: Extract<Content, { type: "group" }>
): Promise<SendResult> => {
  const groupMembers: SendResult[] = [];
  try {
    for (const sub of content.items) {
      groupMembers.push(await sendContent(remote, chat, sub.content));
    }
  } catch (err) {
    throw new PartialGroupSendError(groupMembers, err);
  }

  const first = groupMembers[0];
  if (!first) {
    throw new Error("Empty group");
  }
  return { ...first, groupMembers };
};

const resolveReplyTarget = (
  msgId: string,
  target: IMessageMessage | undefined
): ReplyTarget => {
  const childRef = parseChildId(msgId);
  const parentGuid = target?.parentId ?? childRef?.parentGuid ?? msgId;
  const partIndex = target?.partIndex ?? childRef?.partIndex;
  const guid = messageGuid(parentGuid);
  return typeof partIndex === "number" ? { guid, partIndex } : guid;
};

/**
 * Sends iMessage content. Group sends use native multipart iMessage parts, so
 * attachments must be path-backed and the result's group members are synthetic
 * child references to the parent guid plus each part index.
 */
export const send = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Content,
  options: SendOptionsInternal = {}
): Promise<SendResult> => {
  const chat = chatGuid(spaceId);

  if (content.type === "group") {
    validateGroupContent(content);
    if (!options.nativeMultipartGroups) {
      return sendGroupSequentially(remote, chat, content);
    }

    const parts = toMultipartParts(content);
    const receipt = toSendResult(
      await remote.messages.sendMultipart(chat, parts)
    );
    return {
      ...receipt,
      groupMembers: groupMembersForMultipart(receipt, parts.length),
    };
  }

  return sendContent(remote, chat, content);
};

export const replyToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content,
  target?: IMessageMessage
): Promise<SendResult> => {
  const chat = chatGuid(spaceId);
  const replyTo = resolveReplyTarget(msgId, target);
  return sendContent(remote, chat, content, replyTo);
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
