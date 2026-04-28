import { asAttachment } from "../../../content/attachment";
import { asContact } from "../../../content/contact";
import { asGroup } from "../../../content/group";
import { asPoll } from "../../../content/poll";
import { asRichlink } from "../../../content/richlink";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import { asVoice } from "../../../content/voice";
import type { Message as SpectrumMessage } from "../../../types/message";
import { fromVCard } from "../../../utils/vcard";
import type {
  Audio,
  Chat,
  Document,
  LinkPreviewOptions,
  Message,
  MessageEntity,
  PhotoSize,
  Contact as TgContact,
  Poll as TgPoll,
  Voice as TgVoice,
  User,
  Video,
} from "../generated/types";
import type { TelegramClient } from "../runtime/client";
import type { TelegramMessage } from "../types";

// ---------------------------------------------------------------------------
// Sender / space conversion
// ---------------------------------------------------------------------------

const chatIdToSpaceId = (chatId: number): string => String(chatId);
const userIdToSpectrumId = (userId: number): string => String(userId);

// Inline anonymous return type (rather than a named alias) so the result
// satisfies `ProviderMessageRecord["space"]`'s `Record<string, unknown>` index
// signature when it's used as a stub target — a named `interface` does not.
export const chatToSpace = (
  chat: Chat
): {
  chatId: number;
  id: string;
  title?: string;
  type: Chat["type"];
  username?: string;
} => {
  const space: {
    chatId: number;
    id: string;
    title?: string;
    type: Chat["type"];
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

export interface Sender {
  chatId: number;
  firstName: string;
  id: string;
  isBot: boolean;
  languageCode?: string;
  lastName?: string;
  username?: string;
}

export const userToSender = (user: User): Sender => {
  const sender: Sender = {
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

// Channel posts and anonymous group-admin messages arrive without `from` but
// with `sender_chat`. Synthesize a Sender from the chat so these updates are
// delivered end-to-end instead of silently dropped.
export const chatToSender = (chat: Chat): Sender => {
  const sender: Sender = {
    id: chatIdToSpaceId(chat.id),
    chatId: chat.id,
    isBot: false,
    firstName: chat.title ?? chat.username ?? "Telegram chat",
  };
  if (chat.username !== undefined) {
    sender.username = chat.username;
  }
  return sender;
};

// ---------------------------------------------------------------------------
// File downloads (lazy)
// ---------------------------------------------------------------------------

// getFile URLs are valid for ~1h; resolve lazily per read so stale URLs aren't
// cached and messages that are never consumed cost nothing. The download goes
// through `client.downloadFile` so attachment/voice reads reuse the same
// `TelegramClientOptions.fetch`, per-request timeout, and retry/backoff as
// every other Bot API call.
//
// No `AbortSignal` is threaded in from the polling loop: lazy reads must not
// inherit the event-stream lifetime. If the caller closes the stream, already-
// emitted messages should still be readable. The client transport's own
// timeouts/retries still apply per read.
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
  return await client.downloadFile(file.file_path);
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

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

const parseVCardSafe = (
  vcard: string
): Parameters<typeof asContact>[0] | undefined => {
  try {
    return fromVCard(vcard);
  } catch {
    return undefined;
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
    raw: contact.vcard ?? contact,
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

// ---------------------------------------------------------------------------
// Richlink (text message that's clearly a link card)
// ---------------------------------------------------------------------------

// A message is surfaced as a richlink when the sender clearly meant it as
// a link card: either Telegram points the preview at a specific URL via
// `link_preview_options.url`, or the entire message body is a single url /
// text_link entity and preview is not disabled.
const extractRichlinkUrl = (
  text: string,
  entities: MessageEntity[] | undefined,
  linkPreview: LinkPreviewOptions | undefined
): string | undefined => {
  if (linkPreview?.is_disabled === true) {
    return undefined;
  }
  if (linkPreview?.url) {
    return linkPreview.url;
  }
  if (!entities || entities.length !== 1) {
    return undefined;
  }
  const [entity] = entities;
  if (!entity) {
    return undefined;
  }
  const covers = entity.offset === 0 && entity.length === text.length;
  if (!covers) {
    return undefined;
  }
  if (entity.type === "text_link") {
    return entity.url;
  }
  if (entity.type === "url") {
    return text;
  }
  return undefined;
};

const richlinkFromMessage = (msg: Message): Content | undefined => {
  if (msg.text === undefined) {
    return undefined;
  }
  const url = extractRichlinkUrl(
    msg.text,
    msg.entities,
    msg.link_preview_options
  );
  if (url === undefined) {
    return undefined;
  }
  try {
    return asRichlink({ url });
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Poll (inbound body)
// ---------------------------------------------------------------------------

// Telegram's `Poll.{question, options[].text}` maps cleanly onto Spectrum's
// `poll.{title, options[].title}`: both cap title at 300 chars and allow 2-10
// options. Quiz polls are surfaced the same way — Spectrum has no separate
// quiz content type, and the underlying voting is identical from the bot's
// perspective. We deliberately do NOT carry the bot-only fields
// (is_anonymous / total_voter_count / correct_option_id / etc.) — they're
// reachable on the raw Telegram Message via the underlying client for callers
// who need them, and Spectrum's `Poll` schema has no place for them.
const pollFromTelegramPoll = (poll: TgPoll): Content | undefined => {
  // Telegram in theory enforces these limits server-side, but we guard with
  // a try/catch around `asPoll` to avoid crashing the whole stream if a future
  // server change breaks the assumption (e.g. an option title >300 chars).
  try {
    return asPoll({
      title: poll.question,
      options: poll.options.map((opt) => ({ title: opt.text })),
    });
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Message → Content dispatcher
// ---------------------------------------------------------------------------

// Spectrum's `Content` is a single discriminated-union value, so a Telegram
// message carrying both media and a caption can only surface one of them.
// We prefer the media attachment (the richer payload) and fall back to the
// caption only when no media is present. The accompanying caption is also
// exposed via the `caption` extra on `TelegramMessage` so it isn't lost.
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
  // Caption-only messages (no recognized media) surface the caption as text.
  if (msg.caption !== undefined) {
    return asText(msg.caption);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Top-level message builder
// ---------------------------------------------------------------------------

export const toTelegramMessage = (
  client: TelegramClient,
  msg: Message
): TelegramMessage | undefined => {
  let sender: Sender | undefined;
  if (msg.from) {
    sender = userToSender(msg.from);
  } else if (msg.sender_chat) {
    sender = chatToSender(msg.sender_chat);
  }
  if (!sender) {
    return undefined;
  }
  const content = messageToContent(client, msg);
  if (!content) {
    return undefined;
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
  // Caption is surfaced as an extra only when it accompanies media; for the
  // caption-only case `messageToContent` already returns it as text content
  // and re-emitting it here would duplicate the same string.
  if (msg.caption !== undefined && content.type !== "text") {
    built.caption = msg.caption;
  }
  return built;
};

// ---------------------------------------------------------------------------
// Album coalescing
//
// Telegram albums arrive as N separate `Update`s sharing a `media_group_id`.
// When `coalesceAlbums` is enabled, the events module debounces these into a
// single emission whose content is `asGroup({ items: members })`. Members
// share `chat`, `from`, and a near-identical timestamp; we anchor the
// wrapper on the first arrival.
//
// Members are sorted by their numeric `message_id` so the group respects
// the user's intended composition order even if Bot API delivery is briefly
// out of order. The wrapper's id is `album:<media_group_id>` so callers can
// identify it as a coalesced bundle (and so it doesn't collide with any
// individual member's id in the messages cache — we deliberately do *not*
// cache the wrapper, only its members).
// ---------------------------------------------------------------------------

export const coalesceAlbumGroup = (
  members: TelegramMessage[]
): TelegramMessage | undefined => {
  if (members.length === 0) {
    return undefined;
  }
  if (members.length === 1) {
    // Single-member "album" should fall back to the raw message — `asGroup`
    // requires min 2 items and Spectrum's group semantics don't make sense
    // for one. Can happen when a hard-ceiling flush fires before the rest
    // of the album arrives.
    return members[0];
  }
  const sorted = [...members].sort((a, b) => Number(a.id) - Number(b.id));
  const head = sorted[0];
  if (!head?.mediaGroupId) {
    return undefined;
  }
  const items = sorted as unknown as SpectrumMessage[];
  const wrapper: TelegramMessage = {
    id: `album:${head.mediaGroupId}`,
    content: asGroup({ items }),
    sender: head.sender,
    space: head.space,
    ...(head.timestamp ? { timestamp: head.timestamp } : {}),
    mediaGroupId: head.mediaGroupId,
  };
  // Telegram captions an album by attaching the caption to *one* member
  // (typically the first). Surface that on the wrapper so consumers don't
  // have to scan items themselves.
  const captioned = sorted.find((m) => m.caption !== undefined);
  if (captioned?.caption !== undefined) {
    wrapper.caption = captioned.caption;
  }
  return wrapper;
};
