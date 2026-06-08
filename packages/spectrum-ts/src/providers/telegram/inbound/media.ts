import { asAttachment } from "../../../content/attachment";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import { asVoice } from "../../../content/voice";
import { downloadFile } from "../client";
import type { TelegramConfig } from "../config";
import type { Message, PhotoSize } from "../types";

const DEFAULT_VIDEO_MIME = "video/mp4";
const DEFAULT_AUDIO_MIME = "audio/mpeg";
const DEFAULT_VOICE_MIME = "audio/ogg";
const DEFAULT_DOC_MIME = "application/octet-stream";

const pixelArea = (photo: PhotoSize): number =>
  photo.file_size ?? photo.width * photo.height;

/** Telegram sends several `PhotoSize`s; pick the largest (best quality). */
const pickLargestPhoto = (photos: PhotoSize[]): PhotoSize =>
  photos.reduce((best, next) =>
    pixelArea(next) > pixelArea(best) ? next : best
  );

// The fields every Telegram file object shares (Document/Video/Audio/Animation/
// PhotoSize/...). `file_name`/`mime_type` are absent on some kinds, so callers
// pass a fallback extension + MIME type.
interface TgFile {
  file_id: string;
  file_name?: string;
  file_size?: number;
  file_unique_id: string;
  mime_type?: string;
}

const lazyRead = (config: TelegramConfig, fileId: string) => () =>
  downloadFile(config, fileId);

/** Build an attachment from any Telegram file, falling back when unnamed/untyped. */
const fileAttachment = (
  config: TelegramConfig,
  file: TgFile,
  fallbackExt: string,
  fallbackMime: string
): Content =>
  asAttachment({
    id: file.file_id,
    name: file.file_name ?? `${file.file_unique_id}.${fallbackExt}`,
    mimeType: file.mime_type ?? fallbackMime,
    size: file.file_size,
    read: lazyRead(config, file.file_id),
  });

const stickerAttachment = (
  config: TelegramConfig,
  sticker: NonNullable<Message["sticker"]>
): Content => {
  let ext = "webp";
  let mimeType = "image/webp";
  if (sticker.is_animated) {
    ext = "tgs";
    mimeType = "application/x-tgsticker";
  } else if (sticker.is_video) {
    ext = "webm";
    mimeType = "video/webm";
  }
  return asAttachment({
    id: sticker.file_id,
    name: `${sticker.file_unique_id}.${ext}`,
    mimeType,
    size: sticker.file_size,
    read: lazyRead(config, sticker.file_id),
  });
};

/**
 * Map a Telegram `Message` to its media `Content`, or `undefined` if it carries
 * no media. A message holds at most one media kind, but `animation` also
 * populates `document` (and stickers have sub-types), so detection runs in a
 * fixed first-match order: voice → video_note → animation → video → audio →
 * document → photo → sticker.
 *
 * Bytes are read lazily: each `read()` runs `getFile` + an authenticated
 * download only when the consumer calls it, keeping the webhook ack path free
 * of network I/O. The `as*` builders memoize `read`, so a file downloads once.
 */
const mediaToContent = (
  msg: Message,
  config: TelegramConfig
): Content | undefined => {
  if (msg.voice) {
    return asVoice({
      mimeType: msg.voice.mime_type ?? DEFAULT_VOICE_MIME,
      duration: msg.voice.duration,
      size: msg.voice.file_size,
      read: lazyRead(config, msg.voice.file_id),
    });
  }
  if (msg.video_note) {
    return fileAttachment(config, msg.video_note, "mp4", DEFAULT_VIDEO_MIME);
  }
  if (msg.animation) {
    return fileAttachment(config, msg.animation, "mp4", DEFAULT_VIDEO_MIME);
  }
  if (msg.video) {
    return fileAttachment(config, msg.video, "mp4", DEFAULT_VIDEO_MIME);
  }
  if (msg.audio) {
    return fileAttachment(config, msg.audio, "mp3", DEFAULT_AUDIO_MIME);
  }
  if (msg.document) {
    return fileAttachment(config, msg.document, "bin", DEFAULT_DOC_MIME);
  }
  if (msg.photo && msg.photo.length > 0) {
    return fileAttachment(
      config,
      pickLargestPhoto(msg.photo),
      "jpg",
      "image/jpeg"
    );
  }
  if (msg.sticker) {
    return stickerAttachment(config, msg.sticker);
  }
  return;
};

/**
 * Map an inbound `Message` to its Spectrum `Content` parts: the media (if any)
 * plus its `caption` as a leading text part, or a bare `text` message. Returns
 * `[]` when nothing is representable (service messages, etc.) so the caller can
 * drop it.
 */
export const messageToContent = (
  msg: Message,
  config: TelegramConfig
): Content[] => {
  const media = mediaToContent(msg, config);
  if (media) {
    const caption = msg.caption?.trim();
    return caption ? [asText(caption), media] : [media];
  }
  const text = msg.text;
  if (text !== undefined && text.length > 0) {
    return [asText(text)];
  }
  return [];
};
