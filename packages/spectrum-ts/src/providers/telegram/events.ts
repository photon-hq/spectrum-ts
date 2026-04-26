import { asAttachment } from "../../content/attachment";
import { asContact } from "../../content/contact";
import { asCustom } from "../../content/custom";
import { asPoll } from "../../content/poll";
import { asReaction } from "../../content/reaction";
import { asRichlink } from "../../content/richlink";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import { asVoice } from "../../content/voice";
import type { ProviderMessageRecord } from "../../platform/build";
import { type ManagedStream, stream } from "../../utils/stream";
import { fromVCard } from "../../utils/vcard";
import type {
  Audio,
  Chat,
  Document,
  LinkPreviewOptions,
  Message,
  MessageEntity,
  MessageReactionUpdated,
  PhotoSize,
  ReactionType,
  Contact as TgContact,
  Poll as TgPoll,
  Voice as TgVoice,
  Update,
  User,
  Video,
} from "./generated/types";
import type { TelegramClient } from "./runtime/client";
import { pollUpdates } from "./runtime/polling";
import type { TelegramMessage, TelegramRuntime } from "./types";

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

interface Sender {
  chatId: number;
  firstName: string;
  id: string;
  isBot: boolean;
  languageCode?: string;
  lastName?: string;
  username?: string;
}

const userToSender = (user: User): Sender => {
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
const chatToSender = (chat: Chat): Sender => {
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

// Spectrum's `Content` is a single discriminated-union value, so a Telegram
// message carrying both media and a caption can only surface one of them.
// We prefer the media attachment (the richer payload) and fall back to the
// caption only when no media is present. A future compound content type would
// let us expose both; until then the caption that accompanies media is not
// lost silently because it's also exposed via `msg.caption` on the raw
// Telegram `Message` reachable through `startTyping`/webhook helpers.
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

const toTelegramMessage = (
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

const pickMessage = (update: Update): Message | undefined =>
  update.message ??
  update.edited_message ??
  update.channel_post ??
  update.edited_channel_post;

// ---------------------------------------------------------------------------
// Reactions (inbound)
//
// Telegram's `message_reaction` update carries a diff (`old_reaction` vs
// `new_reaction`) per user per message. Spectrum's `reaction` content is
// add-only and plain-unicode, so we only emit the newly-added emoji
// reactions from each update. Everything else is deliberately skipped with
// a comment so the gap is grep-able once the schema grows richer.
//
// TODO(reactions): when `reactionSchema` gains `action: "add" | "remove"`,
//   emit remove events for emojis that left `new_reaction`.
// TODO(reactions): when `reactionSchema` can carry custom emoji (e.g. an
//   `emojiKind: "custom"` + id field), surface ReactionTypeCustomEmoji.
//   Paid reactions have no emoji payload and will likely stay dropped.
// TODO(reactions): consider surfacing `message_reaction_count` as a
//   separate snapshot content type for anonymous channels.
// ---------------------------------------------------------------------------

// Defensive against schema drift: `ReactionType{emoji}` declares `emoji` as
// required, but upstream Telegram payloads have historically omitted fields
// during API transitions. Treat a missing/empty string as "no reaction" to
// keep the diff against `old_reaction` correct instead of emitting `""`.
const extractEmoji = (reaction: ReactionType): string | undefined => {
  if (reaction.type !== "emoji") {
    return undefined;
  }
  return reaction.emoji ? reaction.emoji : undefined;
};

const newlyAddedEmojis = (update: MessageReactionUpdated): string[] => {
  const previous = new Set(
    update.old_reaction.map(extractEmoji).filter((e): e is string => !!e)
  );
  const added: string[] = [];
  for (const reaction of update.new_reaction) {
    const emoji = extractEmoji(reaction);
    if (emoji && !previous.has(emoji)) {
      added.push(emoji);
    }
  }
  return added;
};

// Telegram's `message_reaction` update only gives us the target's message id
// (not the original sender, content, or anything else). PR #33 narrowed
// `reaction.target` to `Message`, so we synthesize a minimal raw provider
// record here and let core's `wrapProviderMessage` inflate it into a full
// Message (with `react`/`reply`) before agents see the event. Same approach
// used by the WhatsApp Business and terminal providers.
const reactionTargetStub = (
  messageId: number,
  space: ReturnType<typeof chatToSpace>,
  timestamp: Date
): ProviderMessageRecord => ({
  id: String(messageId),
  content: asCustom({ telegram_type: "reaction-target", stub: true }),
  sender: { id: "__unknown__" },
  space,
  timestamp,
});

const reactionEventsFromUpdate = (
  update: MessageReactionUpdated,
  updateId: number
): TelegramMessage[] => {
  // Anonymous actors (actor_chat, no user) can't produce a Spectrum sender; the
  // content-type carries no "chat reactor" concept today. Drop for now.
  if (!update.user) {
    return [];
  }
  const sender = userToSender(update.user);
  const space = chatToSpace(update.chat);
  const timestamp = new Date(update.date * 1000);
  const target = reactionTargetStub(update.message_id, space, timestamp);
  return newlyAddedEmojis(update).map((emoji, index) => ({
    // update_id is unique per update, message_id is the *target* of the
    // reaction (not the reaction's own id — Telegram doesn't surface one), so
    // compose a stable id per emitted event.
    id: `reaction:${updateId}:${index}`,
    // The stub deliberately lacks `react`/`reply` methods; `wrapProviderMessage`
    // detects raw provider records via `isRawProviderRecord` and inflates them
    // into full Messages before the reaction is emitted to consumers.
    content: asReaction({
      emoji,
      target: target as unknown as Parameters<typeof asReaction>[0]["target"],
    }),
    sender,
    space,
    timestamp,
  }));
};

// ---------------------------------------------------------------------------
// Polls (inbound)
//
// Telegram surfaces poll-related state through three update kinds:
//   1. `Update.message.poll`  — initial poll body when a user sends a poll.
//                               Mapped to Spectrum's `poll` content via
//                               `pollFromTelegramPoll` (above). Arrives on
//                               the regular `message` update — no extra
//                               `allowed_updates` opt-in needed.
//   2. `Update.poll`          — aggregate state changes (vote totals,
//                               closure). Bots only receive `poll` updates
//                               for polls they sent themselves. Not mapped:
//                               there is no chat/message id on this update,
//                               and Spectrum has no "poll snapshot" content.
//   3. `Update.poll_answer`   — per-user vote diff in non-anonymous polls.
//                               Not mapped to `poll_option`: faithful
//                               resolution requires a per-poll cache
//                               (`poll_answer` omits chat, message id, and
//                               option text), and we don't ship a stateful
//                               cache from this provider.
//
// Callers wanting (2) or (3) can override `allowedUpdates` and subscribe to
// the raw client.
// ---------------------------------------------------------------------------

const buildMessages = (
  client: TelegramClient,
  update: Update
): TelegramMessage[] => {
  if (update.message_reaction) {
    return reactionEventsFromUpdate(update.message_reaction, update.update_id);
  }
  const tgMessage = pickMessage(update);
  if (!tgMessage) {
    return [];
  }
  const message = toTelegramMessage(client, tgMessage);
  return message ? [message] : [];
};

export interface MessagesOptions {
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
  timeout?: number;
}

export const messages = (
  runtime: TelegramRuntime,
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
          runtime.client,
          abortController.signal,
          options
        )) {
          const built = buildMessages(runtime.client, update);
          for (const message of built) {
            await emit(message);
          }
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
