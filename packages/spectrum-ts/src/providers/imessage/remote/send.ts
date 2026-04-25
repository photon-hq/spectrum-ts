import {
  type AdvancedIMessage,
  chatGuid,
  messageGuid,
} from "@photon-ai/advanced-imessage";
import type { Content } from "../../../content/types";
import type { SendResult } from "../../../platform/types";
import { ensureM4a } from "../../../utils/audio";
import { toVCard } from "../../../utils/vcard";
import { unsupportedRemoteContent } from "../shared/errors";
import { vcardFileName } from "../shared/vcard";
import type { IMessageMessage } from "../types";

const GROUP_ITEM_ALLOWED: ReadonlySet<Content["type"]> = new Set([
  "attachment",
  "contact",
  "voice",
]);

type ChatGuid = ReturnType<typeof chatGuid>;
type ReplyGuid = ReturnType<typeof messageGuid>;

interface MessageSendOptions {
  attachment?: string;
  audioMessage?: boolean;
  replyTo?: ReplyGuid;
  richLink?: boolean;
}

const toSendResult = (receipt: { guid: unknown }): SendResult => ({
  id: receipt.guid as string,
  timestamp: new Date(),
});

const withReply = (
  options: MessageSendOptions,
  replyTo: ReplyGuid | undefined
): MessageSendOptions => (replyTo ? { ...options, replyTo } : options);

const replyOptions = (
  replyTo: ReplyGuid | undefined
): MessageSendOptions | undefined => (replyTo ? { replyTo } : undefined);

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
) => {
  const vcf = await toVCard(content);
  const upload = await sendVCardAttachment(remote, vcardFileName(content), vcf);
  return upload.guid;
};

const uploadAttachment = async (
  remote: AdvancedIMessage,
  content: Extract<Content, { type: "attachment" }>
): Promise<string> => {
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
): Promise<string> => {
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
  replyTo?: ReplyGuid
): Promise<SendResult> => {
  switch (content.type) {
    case "text":
      return toSendResult(
        replyTo
          ? await remote.messages.send(chat, content.text, { replyTo })
          : await remote.messages.send(chat, content.text)
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
    default:
      throw unsupportedRemoteContent(content.type);
  }
};

export const validateGroupContent = (
  content: Extract<Content, { type: "group" }>
): void => {
  // Strict validation: fail before any native send when a group contains items
  // iMessage cannot carry natively.
  for (const sub of content.items as unknown as IMessageMessage[]) {
    const itemType = sub.content.type;
    if (!GROUP_ITEM_ALLOWED.has(itemType)) {
      throw unsupportedRemoteContent(
        "group",
        `"${itemType}" items are not supported inside a group`
      );
    }
  }
};

export const send = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Content
): Promise<SendResult> => {
  const chat = chatGuid(spaceId);

  if (content.type === "group") {
    validateGroupContent(content);

    // The SDK has no single multi-attachment send with uploaded bytes
    // (MessagePart requires server-side paths; upload returns guids only),
    // so we fall back to N sequential sends. Return per-child receipts on
    // `groupMembers` so the platform layer can build real outbound Messages
    // for each group item. The outer `id` tracks the first child purely for
    // OutboundMessage compatibility: prefer items[i].id for per-item ops.
    const groupMembers: SendResult[] = [];
    for (const sub of content.items as unknown as IMessageMessage[]) {
      groupMembers.push(await sendContent(remote, chat, sub.content));
    }
    const first = groupMembers[0];
    if (!first) {
      throw new Error("Empty group");
    }
    return { ...first, groupMembers };
  }

  return sendContent(remote, chat, content);
};

export const replyToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content
): Promise<SendResult> => {
  const chat = chatGuid(spaceId);
  const replyTo = messageGuid(msgId);
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
