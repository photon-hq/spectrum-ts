import type {
  AdvancedIMessage,
  MessageEffect,
  MessagePart,
  Poll,
  Message as SDKMessage,
  SendOptions,
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
import {
  type AttachmentGuid,
  type ChatGuid,
  formatChildId,
  parseChildId,
  toChatGuid,
  toMessageGuid,
} from "./ids";

const GROUP_ITEM_ALLOWED: ReadonlySet<Content["type"]> = new Set([
  "text",
  "attachment",
  "contact",
  "voice",
]);
const MAX_GROUP_TEXT_ITEMS = 1;

type ReplyTarget = SendOptions["replyTo"];

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

const outboundGroupItem = (
  spaceId: string,
  id: string,
  content: Content,
  timestamp: Date,
  partIndex: number,
  parentId: string
): IMessageMessage =>
  outboundRecord(spaceId, id, content, timestamp, {
    partIndex,
    parentId,
  }) as IMessageMessage;

const providerGroup = (items: IMessageMessage[]): Content =>
  asGroup({ items: items as unknown as Message[] });

const withReply = (
  options: SendOptions,
  replyTo: ReplyTarget | undefined
): SendOptions => (replyTo ? { ...options, replyTo } : options);

const replyOptions = (
  replyTo: ReplyTarget | undefined
): SendOptions | undefined => (replyTo ? { replyTo } : undefined);

const effectOption = (
  effect: MessageEffect | undefined
): Pick<SendOptions, "effect"> => (effect ? { effect } : {});

const replyTargetFromId = (messageId: string): ReplyTarget => {
  const childRef = parseChildId(messageId);
  if (childRef) {
    return {
      guid: toMessageGuid(childRef.parentGuid),
      partIndex: childRef.partIndex,
    };
  }
  return toMessageGuid(messageId);
};

const outboundMessage = (
  spaceId: string,
  message: SDKMessage,
  content: Content
): ProviderMessageRecord =>
  outboundRecord(spaceId, message.guid, content, message.dateCreated);

const outboundPoll = (
  spaceId: string,
  poll: Poll,
  content: Content
): ProviderMessageRecord =>
  outboundRecord(spaceId, poll.pollMessageGuid, content, new Date());

const sendVCardAttachment = (
  remote: AdvancedIMessage,
  name: string,
  vcf: string
) =>
  remote.attachments.upload({
    data: Buffer.from(vcf, "utf8"),
    fileName: name,
  });

const sendContactAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "contact" }>
): Promise<{ guid: AttachmentGuid; name: string }> => {
  const vcf = await toVCard(content);
  const name = vcardFileName(content);
  const upload = await sendVCardAttachment(remote, name, vcf);
  return { guid: upload.attachment.guid, name };
};

const uploadAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "attachment" }>
): Promise<{ guid: AttachmentGuid; name: string }> => {
  const attachment = await remote.attachments.upload({
    data: await content.read(),
    fileName: content.name,
  });
  return { guid: attachment.attachment.guid, name: content.name };
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
  });
  return { guid: attachment.attachment.guid, name };
};

const sendContent = async (
  remote: AdvancedIMessage,
  spaceId: string,
  chat: ChatGuid,
  content: Content,
  replyTo?: ReplyTarget,
  effect?: MessageEffect
): Promise<ProviderMessageRecord> => {
  switch (content.type) {
    case "effect":
      return sendContent(
        remote,
        spaceId,
        chat,
        content.content,
        replyTo,
        content.effect as MessageEffect
      );
    case "text": {
      const message = await remote.messages.sendText(
        chat,
        content.text,
        withReply(effectOption(effect), replyTo)
      );
      return outboundMessage(spaceId, message, content);
    }
    case "richlink": {
      const message = await remote.messages.sendText(
        chat,
        content.url,
        withReply({ enableLinkPreview: true }, replyTo)
      );
      return outboundMessage(spaceId, message, content);
    }
    case "attachment": {
      const { guid } = await uploadAttachment(remote, content);
      const message = await remote.messages.sendAttachment(
        chat,
        guid,
        withReply(effectOption(effect), replyTo)
      );
      return outboundMessage(spaceId, message, content);
    }
    case "contact": {
      const { guid } = await sendContactAttachment(remote, content);
      const message = await remote.messages.sendAttachment(
        chat,
        guid,
        replyOptions(replyTo)
      );
      return outboundMessage(spaceId, message, content);
    }
    case "voice": {
      const { guid } = await uploadVoice(remote, content);
      const message = await remote.messages.sendAttachment(chat, guid, {
        isAudioMessage: true,
        ...replyOptions(replyTo),
      });
      return outboundMessage(spaceId, message, content);
    }
    case "poll":
      if (replyTo) {
        throw unsupportedRemoteContent(
          "poll",
          "polls cannot be sent as replies"
        );
      }
      return outboundPoll(
        spaceId,
        await remote.polls.create(
          chat,
          content.title,
          content.options.map((option) => option.title)
        ),
        content
      );
    default:
      throw unsupportedRemoteContent(content.type);
  }
};

export const validateGroupContent = (
  content: Extract<Content, { type: "group" }>
): void => {
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
      const { guid, name } = await uploadVoice(remote, content);
      return { attachmentGuid: guid, attachmentName: name };
    }
    default:
      throw unsupportedRemoteContent(content.type);
  }
};

export const send = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const chat = toChatGuid(spaceId);

  if (content.type === "group") {
    validateGroupContent(content);

    const resolved = await Promise.all(
      content.items.map((sub) => resolvePart(remote, sub.content))
    );
    const message = await remote.messages.sendMultipart(
      chat,
      resolved.map((part, idx) => ({ ...part, bubbleIndex: idx }))
    );
    const parentGuid = message.guid;
    const timestamp = message.dateCreated;

    const items = content.items.map((sub, idx) =>
      outboundGroupItem(
        spaceId,
        formatChildId(idx, parentGuid),
        sub.content,
        timestamp,
        idx,
        parentGuid
      )
    );

    return outboundRecord(spaceId, parentGuid, providerGroup(items), timestamp);
  }

  return sendContent(remote, spaceId, chat, content);
};

export const replyToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const chat = toChatGuid(spaceId);
  return sendContent(remote, spaceId, chat, content, replyTargetFromId(msgId));
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

  const childRef = parseChildId(msgId);
  await remote.messages.edit(
    toChatGuid(spaceId),
    toMessageGuid(childRef?.parentGuid ?? msgId),
    content.text,
    childRef ? { partIndex: childRef.partIndex } : undefined
  );
};

// Retract a previously-sent message. Apple enforces an ~2-minute unsend
// window — late or repeated unsends reject with the SDK's error, which
// propagates to the caller rather than warn-and-skip.
export const unsendMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string
): Promise<void> => {
  const childRef = parseChildId(msgId);
  await remote.messages.unsend(
    toChatGuid(spaceId),
    toMessageGuid(childRef?.parentGuid ?? msgId),
    childRef ? { partIndex: childRef.partIndex } : undefined
  );
};
