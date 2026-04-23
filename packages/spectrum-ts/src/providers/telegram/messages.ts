import type { Attachment } from "../../content/attachment";
import type { Contact } from "../../content/contact";
import type { Richlink } from "../../content/richlink";
import type { Content } from "../../content/types";
import type { Voice } from "../../content/voice";
import type { SendResult } from "../../platform/types";
import { UnsupportedError } from "../../utils/errors";
import { toVCard } from "../../utils/vcard";
import type { LinkPreviewOptions, Message } from "./generated/types";
import type { TelegramClient } from "./runtime/client";

const PLATFORM_NAME = "Telegram";

const toChatId = (spaceId: string): number | string => {
  const asNumber = Number(spaceId);
  if (Number.isInteger(asNumber) && String(asNumber) === spaceId) {
    return asNumber;
  }
  return spaceId;
};

const toMessageId = (messageId: string): number => {
  const parsed = Number(messageId);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid Telegram message_id: ${messageId}`);
  }
  return parsed;
};

const toSendResult = (message: Message): SendResult => ({
  id: String(message.message_id),
  timestamp: new Date(message.date * 1000),
});

const attachmentToFile = async (att: Attachment): Promise<File> => {
  const buffer = await att.read();
  return new File([buffer], att.name, { type: att.mimeType });
};

const voiceFile = async (voice: Voice): Promise<File> => {
  const buffer = await voice.read();
  const name = voice.name ?? "voice.ogg";
  return new File([buffer], name, { type: voice.mimeType });
};

type AttachmentRoute = "photo" | "video" | "audio" | "document";

const routeAttachment = (mime: string): AttachmentRoute => {
  if (mime.startsWith("image/")) {
    // GIFs go via sendDocument; sendPhoto rejects them.
    if (mime === "image/gif") {
      return "document";
    }
    return "photo";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  return "document";
};

interface SendOpts {
  replyToMessageId?: number;
}

const replyParams = (
  opts: SendOpts
): { reply_parameters: { message_id: number } } | Record<string, never> =>
  opts.replyToMessageId === undefined
    ? {}
    : { reply_parameters: { message_id: opts.replyToMessageId } };

const sendText = async (
  client: TelegramClient,
  spaceId: string,
  text: string,
  opts: SendOpts
): Promise<SendResult> => {
  const message = await client.invoke("sendMessage", {
    chat_id: toChatId(spaceId),
    text,
    ...replyParams(opts),
  });
  return toSendResult(message);
};

// Telegram generates the preview card server-side by scraping OG metadata from
// the URL, so we don't forward Richlink.title / summary / cover — Telegram
// fetches its own. Pinning `url` explicitly unlocks prefer_large_media (which
// is ignored without an explicit url), which is what turns a plain link into a
// big preview card — i.e. the whole point of a richlink.
const richlinkPreviewOptions = (url: string): LinkPreviewOptions => ({
  is_disabled: false,
  url,
  prefer_large_media: true,
  show_above_text: true,
});

const sendRichlinkContent = async (
  client: TelegramClient,
  spaceId: string,
  richlink: Richlink,
  opts: SendOpts
): Promise<SendResult> => {
  const message = await client.invoke("sendMessage", {
    chat_id: toChatId(spaceId),
    text: richlink.url,
    link_preview_options: richlinkPreviewOptions(richlink.url),
    ...replyParams(opts),
  });
  return toSendResult(message);
};

const sendAttachment = async (
  client: TelegramClient,
  spaceId: string,
  att: Attachment,
  opts: SendOpts
): Promise<SendResult> => {
  const chat_id = toChatId(spaceId);
  const file = await attachmentToFile(att);
  const reply = replyParams(opts);
  const route = routeAttachment(att.mimeType);

  switch (route) {
    case "photo": {
      const message = await client.invoke("sendPhoto", {
        chat_id,
        photo: file,
        ...reply,
      });
      return toSendResult(message);
    }
    case "video": {
      const message = await client.invoke("sendVideo", {
        chat_id,
        video: file,
        ...reply,
      });
      return toSendResult(message);
    }
    case "audio": {
      const message = await client.invoke("sendAudio", {
        chat_id,
        audio: file,
        ...reply,
      });
      return toSendResult(message);
    }
    case "document": {
      const message = await client.invoke("sendDocument", {
        chat_id,
        document: file,
        ...reply,
      });
      return toSendResult(message);
    }
    default: {
      const _exhaustive: never = route;
      throw new Error(`Unhandled attachment route: ${String(_exhaustive)}`);
    }
  }
};

const sendVoiceContent = async (
  client: TelegramClient,
  spaceId: string,
  voice: Voice,
  opts: SendOpts
): Promise<SendResult> => {
  const file = await voiceFile(voice);
  const message = await client.invoke("sendVoice", {
    chat_id: toChatId(spaceId),
    voice: file,
    ...(voice.duration === undefined
      ? {}
      : { duration: Math.round(voice.duration) }),
    ...replyParams(opts),
  });
  return toSendResult(message);
};

const VCARD_MAX_BYTES = 2048;

const hasExtraContactData = (contact: Contact): boolean =>
  (contact.phones?.length ?? 0) > 1 ||
  (contact.emails?.length ?? 0) > 0 ||
  (contact.addresses?.length ?? 0) > 0 ||
  (contact.urls?.length ?? 0) > 0 ||
  contact.org !== undefined ||
  contact.birthday !== undefined ||
  contact.note !== undefined ||
  contact.photo !== undefined ||
  (typeof contact.raw === "string" && contact.raw.startsWith("BEGIN:VCARD"));

const buildVCardField = async (
  contact: Contact
): Promise<string | undefined> => {
  if (!hasExtraContactData(contact)) {
    return undefined;
  }
  const card = await toVCard(contact);
  if (Buffer.byteLength(card, "utf8") > VCARD_MAX_BYTES) {
    return undefined;
  }
  return card;
};

const sendContactContent = async (
  client: TelegramClient,
  spaceId: string,
  contact: Contact,
  opts: SendOpts
): Promise<SendResult> => {
  const phone = contact.phones?.[0]?.value;
  if (!phone) {
    throw new Error(
      "Telegram sendContact requires at least one phone number on the contact"
    );
  }
  const firstName = contact.name?.first ?? contact.name?.formatted ?? "Contact";
  const params: {
    chat_id: number | string;
    phone_number: string;
    first_name: string;
    last_name?: string;
    vcard?: string;
    reply_parameters?: { message_id: number };
  } = {
    chat_id: toChatId(spaceId),
    phone_number: phone,
    first_name: firstName,
  };
  if (contact.name?.last !== undefined) {
    params.last_name = contact.name.last;
  }
  const vcard = await buildVCardField(contact);
  if (vcard !== undefined) {
    params.vcard = vcard;
  }
  const reply = replyParams(opts);
  if ("reply_parameters" in reply) {
    params.reply_parameters = reply.reply_parameters;
  }
  const message = await client.invoke("sendContact", params);
  return toSendResult(message);
};

const dispatchSend = async (
  client: TelegramClient,
  spaceId: string,
  content: Content,
  opts: SendOpts
): Promise<SendResult> => {
  switch (content.type) {
    case "text":
      return await sendText(client, spaceId, content.text, opts);
    case "richlink":
      return await sendRichlinkContent(client, spaceId, content, opts);
    case "attachment":
      return await sendAttachment(client, spaceId, content, opts);
    case "voice":
      return await sendVoiceContent(client, spaceId, content, opts);
    case "contact":
      return await sendContactContent(client, spaceId, content, opts);
    case "custom":
      throw UnsupportedError.content("custom", PLATFORM_NAME);
    default: {
      const _exhaustive: never = content;
      throw UnsupportedError.content(
        (_exhaustive as { type: string }).type,
        PLATFORM_NAME
      );
    }
  }
};

export const send = (
  client: TelegramClient,
  spaceId: string,
  content: Content
): Promise<SendResult> => dispatchSend(client, spaceId, content, {});

export const replyToMessage = (
  client: TelegramClient,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<SendResult> =>
  dispatchSend(client, spaceId, content, {
    replyToMessageId: toMessageId(messageId),
  });

export const editMessage = async (
  client: TelegramClient,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<void> => {
  const targetId = toMessageId(messageId);
  if (content.type !== "text" && content.type !== "richlink") {
    throw UnsupportedError.action(
      "editMessage",
      PLATFORM_NAME,
      `only text/richlink edits are supported, got "${content.type}"`
    );
  }
  const text = content.type === "text" ? content.text : content.url;
  await client.invoke("editMessageText", {
    chat_id: toChatId(spaceId),
    message_id: targetId,
    text,
    ...(content.type === "richlink"
      ? { link_preview_options: richlinkPreviewOptions(content.url) }
      : {}),
  });
};

export const reactToMessage = async (
  client: TelegramClient,
  spaceId: string,
  messageId: string,
  reaction: string
): Promise<void> => {
  await client.invoke("setMessageReaction", {
    chat_id: toChatId(spaceId),
    message_id: toMessageId(messageId),
    reaction: reaction ? [{ type: "emoji", emoji: reaction }] : [],
  });
};

export const startTyping = async (
  client: TelegramClient,
  spaceId: string
): Promise<void> => {
  await client.invoke("sendChatAction", {
    chat_id: toChatId(spaceId),
    action: "typing",
  });
};
