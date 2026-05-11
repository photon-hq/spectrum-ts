import { asAttachment } from "../../../content/attachment";
import { asContact } from "../../../content/contact";
import { asGroup } from "../../../content/group";
import { asPoll } from "../../../content/poll";
import { asRichlink } from "../../../content/richlink";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import { asVoice } from "../../../content/voice";
import { fromVCard } from "../../../utils/vcard";
import type {
  Audio,
  Document,
  LinkPreviewOptions,
  Message,
  MessageEntity,
  PhotoSize,
  Contact as TgContact,
  Poll as TgPoll,
  Voice as TgVoice,
  Video,
} from "../generated/types";

import { chatToSender, chatToSpace, userToSender } from "../identity";
import { toGroupItems } from "../messages";
import type { TelegramClient } from "../runtime/client";
import type { TelegramMessage } from "../types";

// `getFile` URLs are valid for ~1h; resolve lazily on each read so
// messages stay readable after the event stream tears down.
const fetchFileBytes = async (
  client: TelegramClient,
  fileId: string
): Promise<Response> => {
  const file = await client.invoke("getFile", { file_id: fileId });
  if (!file.file_path) {
    throw new Error(
      `Telegram getFile returned no file_path for file_id=${fileId}`
    );
  }
  const response = await client.downloadFile(file.file_path);
  if (!response.ok) {
    throw new Error(
      `Telegram file download for file_id=${fileId} returned HTTP ${response.status}`
    );
  }
  return response;
};

const attachmentFromFile = (
  client: TelegramClient,
  fileId: string,
  name: string,
  mimeType: string,
  size?: number
): Content =>
  asAttachment({
    name,
    mimeType,
    ...(size === undefined ? {} : { size }),
    read: async () =>
      Buffer.from(await (await fetchFileBytes(client, fileId)).arrayBuffer()),
    stream: async () => {
      const response = await fetchFileBytes(client, fileId);
      if (!response.body) {
        throw new Error(
          `Telegram file response has no body (file_id=${fileId})`
        );
      }
      return response.body;
    },
  });

const voiceFromFile = (client: TelegramClient, voice: TgVoice): Content => {
  const mimeType = voice.mime_type ?? "audio/ogg";
  return asVoice({
    mimeType,
    ...(voice.duration === undefined ? {} : { duration: voice.duration }),
    ...(voice.file_size === undefined ? {} : { size: voice.file_size }),
    read: async () =>
      Buffer.from(
        await (await fetchFileBytes(client, voice.file_id)).arrayBuffer()
      ),
    stream: async () => {
      const response = await fetchFileBytes(client, voice.file_id);
      if (!response.body) {
        throw new Error(
          `Telegram voice file has no body (file_id=${voice.file_id})`
        );
      }
      return response.body;
    },
  });
};

const largestPhoto = (photos: PhotoSize[]): PhotoSize | undefined => {
  let best: PhotoSize | undefined;
  for (const photo of photos) {
    const area = photo.width * photo.height;
    if (!best || area > best.width * best.height) {
      best = photo;
    }
  }
  return best;
};

const photoName = (photo: PhotoSize): string => `photo-${photo.file_id}.jpg`;
const documentName = (doc: Document): string =>
  doc.file_name ?? `document-${doc.file_id}`;
const audioName = (audio: Audio): string =>
  audio.file_name ?? `audio-${audio.file_id}`;
const videoName = (video: Video): string =>
  video.file_name ?? `video-${video.file_id}.mp4`;

const parseVCardSafe = (
  vcard: string
): Parameters<typeof asContact>[0] | undefined => {
  try {
    return fromVCard(vcard);
  } catch {
    return;
  }
};

const contactToContent = (contact: TgContact): Content => {
  const formatted = [contact.first_name, contact.last_name]
    .filter((p): p is string => Boolean(p))
    .join(" ");
  const fromCard =
    contact.vcard === undefined ? undefined : parseVCardSafe(contact.vcard);
  const input: Parameters<typeof asContact>[0] = {
    ...(fromCard ?? {}),
    raw: contact,
    name: {
      ...(fromCard?.name ?? {}),
      formatted: formatted || contact.first_name,
      first: contact.first_name,
    },
    phones: fromCard?.phones?.length
      ? fromCard.phones
      : [{ value: contact.phone_number }],
  };
  if (contact.last_name !== undefined && input.name) {
    input.name.last = contact.last_name;
  }
  return asContact(input);
};

// Richlink iff `link_preview_options.url` is set, or the body is exactly
// one `url`/`text_link` entity spanning the entire text.
const extractRichlinkUrl = (
  text: string,
  entities: MessageEntity[] | undefined,
  linkPreview: LinkPreviewOptions | undefined
): string | undefined => {
  if (linkPreview?.is_disabled === true) {
    return;
  }
  if (linkPreview?.url) {
    return linkPreview.url;
  }
  if (!entities || entities.length !== 1) {
    return;
  }
  const [entity] = entities;
  if (!entity) {
    return;
  }
  const covers = entity.offset === 0 && entity.length === text.length;
  if (!covers) {
    return;
  }
  if (entity.type === "text_link") {
    return entity.url;
  }
  if (entity.type === "url") {
    return text;
  }
  return;
};

const richlinkFromMessage = (msg: Message): Content | undefined => {
  if (msg.text === undefined) {
    return;
  }
  const url = extractRichlinkUrl(
    msg.text,
    msg.entities,
    msg.link_preview_options
  );
  if (url === undefined) {
    return;
  }
  try {
    return asRichlink({ url });
  } catch {
    return;
  }
};

const pollFromTelegramPoll = (poll: TgPoll): Content | undefined => {
  try {
    return asPoll({
      title: poll.question,
      options: poll.options.map((opt) => ({ title: opt.text })),
    });
  } catch {
    return;
  }
};

// Media + caption → media content with caption as a `TelegramMessage`
// extra; caption-only → text content.
const messageToContent = (
  client: TelegramClient,
  msg: Message
): Content | undefined => {
  if (msg.text !== undefined) {
    const richlink = richlinkFromMessage(msg);
    if (richlink) {
      return richlink;
    }
    return asText(msg.text);
  }
  if (msg.voice) {
    return voiceFromFile(client, msg.voice);
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = largestPhoto(msg.photo);
    if (largest) {
      return attachmentFromFile(
        client,
        largest.file_id,
        photoName(largest),
        "image/jpeg",
        largest.file_size
      );
    }
  }
  if (msg.document) {
    return attachmentFromFile(
      client,
      msg.document.file_id,
      documentName(msg.document),
      msg.document.mime_type ?? "application/octet-stream",
      msg.document.file_size
    );
  }
  if (msg.audio) {
    return attachmentFromFile(
      client,
      msg.audio.file_id,
      audioName(msg.audio),
      msg.audio.mime_type ?? "audio/mpeg",
      msg.audio.file_size
    );
  }
  if (msg.video) {
    return attachmentFromFile(
      client,
      msg.video.file_id,
      videoName(msg.video),
      msg.video.mime_type ?? "video/mp4",
      msg.video.file_size
    );
  }
  if (msg.contact) {
    return contactToContent(msg.contact);
  }
  if (msg.poll) {
    return pollFromTelegramPoll(msg.poll);
  }
  if (msg.caption !== undefined) {
    return asText(msg.caption);
  }
  return;
};

export const toTelegramMessage = (
  client: TelegramClient,
  msg: Message
): TelegramMessage | undefined => {
  let sender: TelegramMessage["sender"] | undefined;
  if (msg.from) {
    sender = userToSender(msg.from);
  } else if (msg.sender_chat) {
    sender = chatToSender(msg.sender_chat);
  }
  if (!sender) {
    return;
  }
  const content = messageToContent(client, msg);
  if (!content) {
    return;
  }
  const built: TelegramMessage = {
    id: String(msg.message_id),
    content,
    sender,
    space: chatToSpace(msg.chat),
    timestamp: new Date(msg.date * 1000),
  };
  if (msg.media_group_id !== undefined) {
    built.mediaGroupId = msg.media_group_id;
  }
  if (msg.caption !== undefined && content.type !== "text") {
    built.caption = msg.caption;
  }
  return built;
};

// Wrapper id = lead member's `message_id` so reply/edit/setMessageReaction
// (all numeric-id-only) keep working on the coalesced message.
export const coalesceAlbumGroup = (
  members: TelegramMessage[]
): TelegramMessage | undefined => {
  if (members.length === 0) {
    return;
  }
  // `asGroup` requires >= 2 items; ceiling-flush race can leave us with 1.
  if (members.length === 1) {
    return members[0];
  }
  const sorted = [...members].sort((a, b) => Number(a.id) - Number(b.id));
  const head = sorted[0];
  if (!head?.mediaGroupId) {
    return;
  }
  const items = toGroupItems(sorted);
  const wrapper: TelegramMessage = {
    id: head.id,
    content: asGroup({ items }),
    sender: head.sender,
    space: head.space,
    ...(head.timestamp ? { timestamp: head.timestamp } : {}),
    mediaGroupId: head.mediaGroupId,
  };
  // Telegram attaches the album caption to exactly one member; promote it.
  const captioned = sorted.find((m) => m.caption !== undefined);
  if (captioned?.caption !== undefined) {
    wrapper.caption = captioned.caption;
  }
  return wrapper;
};
