import type { ReactionTypeEmoji } from "@grammyjs/types";
import { type Bot, type Context, InputFile } from "grammy";

import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import { asCustom } from "../../content/custom";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { asVoice } from "../../content/voice";
import { type TelegramLogger, withRetry } from "./errors";
import type { ParseMode, TelegramMessage } from "./types";

export type TgMessage = Context["message"] & {};

const fileUrl = (token: string, filePath: string): string =>
  `https://api.telegram.org/file/bot${token}/${filePath}`;

const fetchFile = async (
  bot: Bot,
  fileId: string
): Promise<{ url: string; size?: number }> => {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram returned no file_path for ${fileId}`);
  }
  return { url: fileUrl(bot.token, file.file_path), size: file.file_size };
};

const lazyMedia = (
  bot: Bot,
  fileId: string,
  name: string,
  mimeType: string
): Content =>
  asAttachment({
    name,
    mimeType,
    read: async () => {
      const { url } = await fetchFile(bot, fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Media download failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    stream: async () => {
      const { url } = await fetchFile(bot, fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Media download failed: ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Media response missing body");
      }
      return response.body;
    },
  });

const lazyVoice = (
  bot: Bot,
  fileId: string,
  mimeType: string,
  duration?: number
): Content =>
  asVoice({
    mimeType,
    duration,
    read: async () => {
      const { url } = await fetchFile(bot, fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Voice download failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    stream: async () => {
      const { url } = await fetchFile(bot, fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Voice download failed: ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Voice response missing body");
      }
      return response.body;
    },
  });

const mapTextContent = (msg: TgMessage): Content | undefined => {
  if (msg.text) {
    return asText(msg.text);
  }
  if (msg.caption) {
    return asText(msg.caption);
  }
  return undefined;
};

const mapMediaContent = (bot: Bot, msg: TgMessage): Content | undefined => {
  if (msg.photo) {
    const largest = msg.photo.at(-1);
    if (largest) {
      return lazyMedia(
        bot,
        largest.file_id,
        `photo-${largest.file_id}.jpg`,
        "image/jpeg"
      );
    }
  }
  if (msg.video) {
    return lazyMedia(
      bot,
      msg.video.file_id,
      msg.video.file_name ?? `video-${msg.video.file_id}.mp4`,
      msg.video.mime_type ?? "video/mp4"
    );
  }
  if (msg.animation) {
    return lazyMedia(
      bot,
      msg.animation.file_id,
      msg.animation.file_name ?? `animation-${msg.animation.file_id}.gif`,
      msg.animation.mime_type ?? "video/mp4"
    );
  }
  if (msg.audio) {
    return lazyMedia(
      bot,
      msg.audio.file_id,
      msg.audio.file_name ?? `audio-${msg.audio.file_id}.mp3`,
      msg.audio.mime_type ?? "audio/mpeg"
    );
  }
  if (msg.document) {
    return lazyMedia(
      bot,
      msg.document.file_id,
      msg.document.file_name ?? `document-${msg.document.file_id}`,
      msg.document.mime_type ?? "application/octet-stream"
    );
  }
  if (msg.voice) {
    return lazyVoice(
      bot,
      msg.voice.file_id,
      msg.voice.mime_type ?? "audio/ogg",
      msg.voice.duration
    );
  }
  if (msg.video_note) {
    return lazyMedia(
      bot,
      msg.video_note.file_id,
      `videonote-${msg.video_note.file_id}.mp4`,
      "video/mp4"
    );
  }
  return undefined;
};

const mapCustomContent = (msg: TgMessage): Content => {
  if (msg.sticker) {
    return asCustom({
      telegram_type: "sticker",
      file_id: msg.sticker.file_id,
      emoji: msg.sticker.emoji,
      set_name: msg.sticker.set_name,
      is_animated: msg.sticker.is_animated,
      is_video: msg.sticker.is_video,
    });
  }
  if (msg.location) {
    return asCustom({
      telegram_type: "location",
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    });
  }
  if (msg.contact) {
    return asContact({
      name: {
        first: msg.contact.first_name,
        last: msg.contact.last_name,
        formatted: [msg.contact.first_name, msg.contact.last_name]
          .filter(Boolean)
          .join(" "),
      },
      phones: msg.contact.phone_number
        ? [{ value: msg.contact.phone_number }]
        : undefined,
      raw: msg.contact.vcard || undefined,
    });
  }
  if (msg.poll) {
    return asCustom({
      telegram_type: "poll",
      question: msg.poll.question,
      options: msg.poll.options,
    });
  }
  if (msg.venue) {
    return asCustom({
      telegram_type: "venue",
      title: msg.venue.title,
      address: msg.venue.address,
      latitude: msg.venue.location.latitude,
      longitude: msg.venue.location.longitude,
    });
  }
  if (msg.dice) {
    return asCustom({
      telegram_type: "dice",
      emoji: msg.dice.emoji,
      value: msg.dice.value,
    });
  }
  return asCustom({ telegram_type: "unknown" });
};

export const mapContent = (bot: Bot, msg: TgMessage): Content =>
  mapTextContent(msg) ?? mapMediaContent(bot, msg) ?? mapCustomContent(msg);

export const toMessage = (bot: Bot, msg: TgMessage): TelegramMessage => ({
  id: String(msg.message_id),
  content: mapContent(bot, msg),
  sender: { id: String(msg.from?.id ?? msg.chat.id) },
  space: { id: String(msg.chat.id), type: msg.chat.type },
  timestamp: new Date(msg.date * 1000),
});

// ---------------------------------------------------------------------------
// Helpers for extracting custom content metadata (parse_mode, reply_markup)
// ---------------------------------------------------------------------------

interface SendOptions {
  parse_mode?: ParseMode;
  // biome-ignore lint/suspicious/noExplicitAny: grammy accepts multiple reply_markup shapes
  reply_markup?: any;
}

const extractSendOptions = (
  content: Content,
  defaultParseMode?: ParseMode
): SendOptions => {
  const opts: SendOptions = {};
  if (defaultParseMode) {
    opts.parse_mode = defaultParseMode;
  }
  if (content.type === "custom" && content.raw) {
    const raw = content.raw as Record<string, unknown>;
    if (raw.parse_mode) {
      opts.parse_mode = raw.parse_mode as ParseMode;
    }
    if (raw.reply_markup) {
      opts.reply_markup = raw.reply_markup;
    }
  }
  return opts;
};

// ---------------------------------------------------------------------------
// Universal action helpers
// ---------------------------------------------------------------------------

export const startTyping = async (bot: Bot, spaceId: string): Promise<void> => {
  await bot.api.sendChatAction(Number(spaceId), "typing");
};

const mimeToMediaType = (
  mimeType: string
): "photo" | "video" | "audio" | "document" => {
  if (mimeType.startsWith("image/")) {
    return "photo";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "document";
};

const sendAttachment = async (
  bot: Bot,
  chatId: number,
  content: Content & { type: "attachment" },
  // biome-ignore lint/suspicious/noExplicitAny: grammy send options vary per media type
  extra?: Record<string, any>
): Promise<number | undefined> => {
  const file = new InputFile(await content.read(), content.name);
  const mediaType = mimeToMediaType(content.mimeType);
  switch (mediaType) {
    case "photo":
      return (await bot.api.sendPhoto(chatId, file, extra)).message_id;
    case "video":
      return (await bot.api.sendVideo(chatId, file, extra)).message_id;
    case "audio":
      return (await bot.api.sendAudio(chatId, file, extra)).message_id;
    case "document":
      return (await bot.api.sendDocument(chatId, file, extra)).message_id;
    default:
      return undefined;
  }
};

export const send = async (
  bot: Bot,
  spaceId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<{ id: string }> => {
  const chatId = Number(spaceId);
  const opts = extractSendOptions(content, defaultParseMode);

  return await withRetry(async () => {
    switch (content.type) {
      case "text": {
        const msg = await bot.api.sendMessage(chatId, content.text, opts);
        return { id: String(msg.message_id) };
      }
      case "attachment": {
        const msgId = await sendAttachment(bot, chatId, content, opts);
        return { id: String(msgId ?? 0) };
      }
      case "contact": {
        const phone = content.phones?.[0]?.value ?? "";
        const firstName = content.name?.first ?? content.name?.formatted ?? "";
        const msg = await bot.api.sendContact(chatId, phone, firstName, {
          last_name: content.name?.last,
          vcard: typeof content.raw === "string" ? content.raw : undefined,
          ...opts,
        });
        return { id: String(msg.message_id) };
      }
      case "voice": {
        const file = new InputFile(await content.read());
        const msg = await bot.api.sendVoice(chatId, file, {
          duration: content.duration ? Math.round(content.duration) : undefined,
          ...opts,
        });
        return { id: String(msg.message_id) };
      }
      case "custom": {
        const raw = content.raw as Record<string, unknown> | undefined;
        if (raw?.text && typeof raw.text === "string") {
          const msg = await bot.api.sendMessage(chatId, raw.text, opts);
          return { id: String(msg.message_id) };
        }
        return { id: "0" };
      }
      default:
        return { id: "0" };
    }
  }, logger);
};

export const reactToMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  reaction: string,
  logger: TelegramLogger
): Promise<void> => {
  await withRetry(
    () =>
      bot.api.setMessageReaction(Number(spaceId), Number(messageId), [
        { type: "emoji", emoji: reaction as ReactionTypeEmoji["emoji"] },
      ]),
    logger
  );
};

export const replyToMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<{ id: string }> => {
  const chatId = Number(spaceId);
  const replyParams = { message_id: Number(messageId) };
  const opts = extractSendOptions(content, defaultParseMode);
  const extra = { ...opts, reply_parameters: replyParams };

  return await withRetry(async () => {
    switch (content.type) {
      case "text": {
        const msg = await bot.api.sendMessage(chatId, content.text, extra);
        return { id: String(msg.message_id) };
      }
      case "attachment": {
        const msgId = await sendAttachment(bot, chatId, content, extra);
        return { id: String(msgId ?? 0) };
      }
      case "contact": {
        const phone = content.phones?.[0]?.value ?? "";
        const firstName = content.name?.first ?? content.name?.formatted ?? "";
        const msg = await bot.api.sendContact(chatId, phone, firstName, {
          last_name: content.name?.last,
          vcard: typeof content.raw === "string" ? content.raw : undefined,
          ...extra,
        });
        return { id: String(msg.message_id) };
      }
      case "voice": {
        const file = new InputFile(await content.read());
        const msg = await bot.api.sendVoice(chatId, file, {
          duration: content.duration ? Math.round(content.duration) : undefined,
          ...extra,
        });
        return { id: String(msg.message_id) };
      }
      default:
        return { id: "0" };
    }
  }, logger);
};

export const editMessage = async (
  bot: Bot,
  spaceId: string,
  messageId: string,
  content: Content,
  logger: TelegramLogger,
  defaultParseMode?: ParseMode
): Promise<void> => {
  const chatId = Number(spaceId);
  const msgId = Number(messageId);
  const opts = extractSendOptions(content, defaultParseMode);

  await withRetry(async () => {
    switch (content.type) {
      case "text":
        await bot.api.editMessageText(chatId, msgId, content.text, opts);
        break;
      case "attachment": {
        const file = new InputFile(await content.read(), content.name);
        const mediaType = mimeToMediaType(content.mimeType);
        await bot.api.editMessageMedia(chatId, msgId, {
          type: mediaType === "photo" ? "photo" : "document",
          media: file,
        });
        break;
      }
      default:
        break;
    }
  }, logger);
};
