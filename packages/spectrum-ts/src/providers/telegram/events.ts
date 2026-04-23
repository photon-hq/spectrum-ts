import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { asVoice } from "../../content/voice";
import { type ManagedStream, stream } from "../../utils/stream";
import type {
  Audio,
  Chat,
  Document,
  Message,
  PhotoSize,
  Contact as TgContact,
  Voice as TgVoice,
  User,
  Video,
} from "./generated/types";
import type { TelegramClient } from "./runtime/client";
import { pollUpdates } from "./runtime/polling";
import type { TelegramMessage } from "./types";

const chatIdToSpaceId = (chatId: number): string => String(chatId);
const userIdToSpectrumId = (userId: number): string => String(userId);

const chatToSpace = (
  chat: Chat
): {
  id: string;
  chatId: number;
  type: Chat["type"];
  title?: string;
  username?: string;
} => {
  const space: {
    id: string;
    chatId: number;
    type: Chat["type"];
    title?: string;
    username?: string;
  } = {
    id: chatIdToSpaceId(chat.id),
    chatId: chat.id,
    type: chat.type,
  };
  if (chat.title !== undefined) {
    space.title = chat.title;
  }
  if (chat.username !== undefined) {
    space.username = chat.username;
  }
  return space;
};

const userToSender = (
  user: User
): {
  id: string;
  chatId: number;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
} => {
  const sender: {
    id: string;
    chatId: number;
    isBot: boolean;
    firstName: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
  } = {
    id: userIdToSpectrumId(user.id),
    chatId: user.id,
    isBot: user.is_bot,
    firstName: user.first_name,
  };
  if (user.last_name !== undefined) {
    sender.lastName = user.last_name;
  }
  if (user.username !== undefined) {
    sender.username = user.username;
  }
  if (user.language_code !== undefined) {
    sender.languageCode = user.language_code;
  }
  return sender;
};

// getFile URLs are valid for ~1h; resolve lazily per read so stale URLs aren't
// cached and messages that are never consumed cost nothing.
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
  const response = await fetch(client.fileUrl(file.file_path));
  if (!response.ok) {
    throw new Error(
      `Telegram file download failed (${response.status}) for file_id=${fileId}`
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

const contactToContent = (contact: TgContact): Content => {
  const formatted = [contact.first_name, contact.last_name]
    .filter((p): p is string => Boolean(p))
    .join(" ");
  const input: Parameters<typeof asContact>[0] = {
    raw: contact,
    name: {
      formatted: formatted || contact.first_name,
      first: contact.first_name,
    },
    phones: [{ value: contact.phone_number }],
  };
  if (contact.last_name !== undefined && input.name) {
    input.name.last = contact.last_name;
  }
  return asContact(input);
};

const messageToContent = (
  client: TelegramClient,
  msg: Message
): Content | undefined => {
  if (msg.text !== undefined) {
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
  if (msg.caption !== undefined) {
    return asText(msg.caption);
  }
  return undefined;
};

const toTelegramMessage = (
  client: TelegramClient,
  msg: Message
): TelegramMessage | undefined => {
  const from = msg.from;
  if (!from) {
    return undefined;
  }
  const content = messageToContent(client, msg);
  if (!content) {
    return undefined;
  }
  return {
    id: String(msg.message_id),
    content,
    sender: userToSender(from),
    space: chatToSpace(msg.chat),
    timestamp: new Date(msg.date * 1000),
  };
};

const extractMessage = (update: {
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  edited_channel_post?: Message;
}): Message | undefined =>
  update.message ??
  update.edited_message ??
  update.channel_post ??
  update.edited_channel_post;

export interface MessagesOptions {
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
  timeout?: number;
}

export const messages = (
  client: TelegramClient,
  signal: AbortSignal,
  options: MessagesOptions = {}
): ManagedStream<TelegramMessage> =>
  stream<TelegramMessage>((emit, end) => {
    const abortController = new AbortController();
    const onSignalAbort = () => abortController.abort(signal.reason);
    if (signal.aborted) {
      abortController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    const pump = (async () => {
      try {
        for await (const update of pollUpdates(
          client,
          abortController.signal,
          options
        )) {
          const tgMessage = extractMessage(update);
          if (!tgMessage) {
            continue;
          }
          const spectrumMessage = toTelegramMessage(client, tgMessage);
          if (!spectrumMessage) {
            continue;
          }
          await emit(spectrumMessage);
        }
        end();
      } catch (err) {
        if (abortController.signal.aborted) {
          end();
          return;
        }
        end(err);
      }
    })();

    return async () => {
      signal.removeEventListener("abort", onSignalAbort);
      abortController.abort();
      await pump;
    };
  });
