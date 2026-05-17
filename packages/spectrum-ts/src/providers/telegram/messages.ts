import type {
  AttachmentInput,
  InboundMedia,
  InboundMessage,
  MediaInput,
  PollInput,
  TelegramClient,
  TelegramEvent,
} from "@photon-ai/telegram";
import { extension as mimeExtension } from "mime-types";
import { asAttachment } from "../../content/attachment";
import { asCustom } from "../../content/custom";
import { asPollOption, type Poll } from "../../content/poll";
import { asReaction } from "../../content/reaction";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import type { ProviderMessageRecord } from "../../platform/types";
import type { Message } from "../../types/message";
import { UnsupportedError } from "../../utils/errors";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
import type { TelegramClients, TelegramMessage } from "./types";

// v1 routes outbound traffic to the first bot. When multi-bot send becomes a
// requirement, extend spaceSchema with an optional `bot` (botId) and pick the
// matching client here.
const primary = (clients: TelegramClients): TelegramClient => {
  const client = clients[0];
  if (!client) {
    throw new Error("No Telegram client available");
  }
  return client;
};

const toRecord = (
  result: { messageId: string; chatId: string },
  spaceId: string,
  content: Content,
  extra: { mediaGroupId?: string; caption?: string } = {}
): ProviderMessageRecord => ({
  id: result.messageId,
  content,
  space: { id: spaceId },
  timestamp: new Date(),
  ...extra,
});

// Poll cache: map from poll id → the Poll content we sent. Used to translate
// inbound `poll_answer` events into `poll_option` content the app can match
// against the original poll. Mirrors whatsapp-business.
const MAX_POLL_CACHE_SIZE = 1000;
const pollCaches = new WeakMap<TelegramClient, Map<string, Poll>>();

const getPollCache = (client: TelegramClient): Map<string, Poll> => {
  let cache = pollCaches.get(client);
  if (!cache) {
    cache = new Map<string, Poll>();
    pollCaches.set(client, cache);
  }
  return cache;
};

const cachePoll = (
  client: TelegramClient,
  pollId: string,
  poll: Poll
): void => {
  const cache = getPollCache(client);
  if (cache.has(pollId)) {
    cache.delete(pollId);
  }
  cache.set(pollId, poll);
  if (cache.size > MAX_POLL_CACHE_SIZE) {
    const first = cache.keys().next().value;
    if (first !== undefined) {
      cache.delete(first);
    }
  }
};

// ---------------------------------------------------------------------------
// Inbound mapping: TelegramEvent → Spectrum messages
// ---------------------------------------------------------------------------

const lazyMedia = (
  client: TelegramClient,
  media: InboundMedia,
  fallbackName: string
): Content => {
  const name = media.filename ?? fallbackName;
  return asAttachment({
    name,
    mimeType: media.mimeType ?? "application/octet-stream",
    ...(media.fileSize === undefined ? {} : { size: media.fileSize }),
    read: async () => {
      const { url } = await client.files.getUrl(media.fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Media download failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    stream: async () => {
      const { url } = await client.files.getUrl(media.fileId);
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
};

const buildSender = (
  from: InboundMessage["from"] | undefined,
  fallbackId: string
) => ({
  id: from?.id ?? fallbackId,
  ...(from?.firstName === undefined ? {} : { firstName: from.firstName }),
  ...(from?.lastName === undefined ? {} : { lastName: from.lastName }),
  ...(from?.username === undefined ? {} : { username: from.username }),
  ...(from?.isBot === undefined ? {} : { isBot: from.isBot }),
  ...(from?.languageCode === undefined
    ? {}
    : { languageCode: from.languageCode }),
});

const inboundMessageToSpectrum = (
  client: TelegramClient,
  msg: InboundMessage
): TelegramMessage =>
  ({
    id: msg.messageId,
    sender: buildSender(msg.from, msg.chat.id),
    space: { id: msg.chat.id },
    timestamp: msg.date,
    ...(msg.mediaGroupId === undefined
      ? {}
      : { mediaGroupId: msg.mediaGroupId }),
    ...(msg.caption === undefined ? {} : { caption: msg.caption }),
    content: mapInboundContent(client, msg),
  }) as TelegramMessage;

const mapMediaContent = (
  client: TelegramClient,
  msg: InboundMessage
): Content | undefined => {
  if (msg.photo) {
    return lazyMedia(client, msg.photo, `photo-${msg.photo.fileUniqueId}.jpg`);
  }
  if (msg.video) {
    return lazyMedia(client, msg.video, `video-${msg.video.fileUniqueId}.mp4`);
  }
  if (msg.audio) {
    return lazyMedia(client, msg.audio, `audio-${msg.audio.fileUniqueId}.mp3`);
  }
  if (msg.voice) {
    return lazyMedia(client, msg.voice, `voice-${msg.voice.fileUniqueId}.ogg`);
  }
  if (msg.document) {
    return lazyMedia(
      client,
      msg.document,
      `document-${msg.document.fileUniqueId}`
    );
  }
  return;
};

const mapStructuredContent = (msg: InboundMessage): Content | undefined => {
  if (msg.sticker) {
    return asCustom({
      telegram_type: "sticker",
      fileId: msg.sticker.fileId,
      fileUniqueId: msg.sticker.fileUniqueId,
      ...(msg.sticker.width === undefined ? {} : { width: msg.sticker.width }),
      ...(msg.sticker.height === undefined
        ? {}
        : { height: msg.sticker.height }),
    });
  }
  if (msg.location) {
    return asCustom({
      telegram_type: "location",
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
      ...(msg.location.title === undefined
        ? {}
        : { title: msg.location.title }),
      ...(msg.location.address === undefined
        ? {}
        : { address: msg.location.address }),
    });
  }
  if (msg.contact) {
    return asCustom({
      telegram_type: "contact",
      phoneNumber: msg.contact.phoneNumber,
      firstName: msg.contact.firstName,
      ...(msg.contact.lastName === undefined
        ? {}
        : { lastName: msg.contact.lastName }),
      ...(msg.contact.vcard === undefined ? {} : { vcard: msg.contact.vcard }),
      ...(msg.contact.userId === undefined
        ? {}
        : { userId: msg.contact.userId }),
    });
  }
  return;
};

const mapInboundContent = (
  client: TelegramClient,
  msg: InboundMessage
): Content =>
  mapMediaContent(client, msg) ??
  mapStructuredContent(msg) ??
  asText(msg.text || msg.caption || "");

const eventToMessages = (
  client: TelegramClient,
  event: TelegramEvent
): TelegramMessage[] => {
  switch (event.type) {
    case "message":
      return [inboundMessageToSpectrum(client, event.message)];
    case "reaction": {
      const r = event.reaction;
      const sender = buildSender(r.from, r.chat.id);
      // Telegram delivers the *current set* of emojis on the message, not a
      // delta. If empty, surface as a custom "cleared" event.
      if (r.emoji.length === 0) {
        return [
          {
            id: `${r.messageId}:reaction-cleared`,
            sender,
            space: { id: r.chat.id },
            timestamp: new Date(),
            content: asCustom({
              telegram_type: "reaction-cleared",
              messageId: r.messageId,
            }),
          } as TelegramMessage,
        ];
      }
      // Synthesize a minimal target Message so asReaction's schema accepts it.
      // Core's wrapProviderMessage rebuilds it into a full Message at emit time.
      const stubTarget = {
        id: r.messageId,
        content: asCustom({ telegram_type: "reaction-target", stub: true }),
      } as unknown as Message;
      return r.emoji.map(
        (emoji, index) =>
          ({
            id:
              r.emoji.length > 1
                ? `${r.messageId}:reaction:${index}`
                : `${r.messageId}:reaction`,
            sender,
            space: { id: r.chat.id },
            timestamp: new Date(),
            content: asReaction({ emoji, target: stubTarget }),
          }) as TelegramMessage
      );
    }
    case "poll_answer": {
      const a = event.answer;
      const poll = getPollCache(client).get(a.pollId);
      const sender = {
        id: a.from?.id ?? "telegram-anonymous",
        ...(a.from?.firstName === undefined
          ? {}
          : { firstName: a.from.firstName }),
        ...(a.from?.username === undefined
          ? {}
          : { username: a.from.username }),
      };
      // No cached poll (we didn't send it, or it predates this process), or
      // vote retracted. Surface as a custom event so apps can still observe it.
      if (!poll || a.optionIds.length === 0) {
        return [
          {
            id: `${a.pollId}:answer`,
            sender,
            space: { id: sender.id },
            timestamp: new Date(),
            content: asCustom({
              telegram_type: "poll_answer",
              pollId: a.pollId,
              optionIds: [...a.optionIds],
            }),
          } as TelegramMessage,
        ];
      }
      return a.optionIds.flatMap((optionIndex, i): TelegramMessage[] => {
        const option = poll.options[optionIndex];
        if (!option) {
          return [];
        }
        return [
          {
            id:
              a.optionIds.length > 1
                ? `${a.pollId}:answer:${i}`
                : `${a.pollId}:answer`,
            sender,
            space: { id: sender.id },
            timestamp: new Date(),
            content: asPollOption({ poll, option, selected: true }),
          } as TelegramMessage,
        ];
      });
    }
    default:
      // "poll" (aggregate vote totals) and "heartbeat" are not surfaced as
      // Spectrum messages — apps that need them use the SDK directly.
      return [];
  }
};

// ---------------------------------------------------------------------------
// Outbound mapping: Spectrum Content → SDK calls
// ---------------------------------------------------------------------------

const mimeToAttachmentKind = (
  mimeType: string
): "photo" | "video" | "audio" | "document" => {
  const mime = mimeType.toLowerCase();
  // image/gif animations don't survive Telegram's photo pipeline; ship as a
  // document so bytes round-trip intact (matches the SDK's attachmentKind).
  if (mime === "image/gif") {
    return "document";
  }
  if (mime.startsWith("image/")) {
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

const attachmentContentToSdk = async (
  content: Extract<Content, { type: "attachment" }>
): Promise<AttachmentInput> => {
  const data = new Uint8Array(await content.read());
  return {
    data,
    mimeType: content.mimeType,
    filename: content.name,
  };
};

const voiceContentToMedia = async (
  content: Extract<Content, { type: "voice" }>
): Promise<MediaInput> => {
  const data = new Uint8Array(await content.read());
  const ext = mimeExtension(content.mimeType);
  const filename = content.name ?? (ext ? `voice.${ext}` : "voice.ogg");
  return {
    data,
    mimeType: content.mimeType,
    filename,
  };
};

const pollContentToSdk = (poll: Poll): PollInput => ({
  question: poll.title,
  options: poll.options.map((o) => o.title),
});

// ---------------------------------------------------------------------------
// Stream wiring
// ---------------------------------------------------------------------------

const clientStream = (
  client: TelegramClient
): ManagedStream<TelegramMessage> => {
  const eventStream = client.events.subscribe();

  return stream<TelegramMessage>((emit, end) => {
    const pump = (async () => {
      try {
        for await (const event of eventStream) {
          for (const m of eventToMessages(client, event)) {
            await emit(m);
          }
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return async () => {
      await eventStream.close();
      await pump;
    };
  });
};

export const messages = (
  clients: TelegramClients
): ManagedStream<TelegramMessage> => mergeStreams(clients.map(clientStream));

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

const sendAttachment = async (
  client: TelegramClient,
  spaceId: string,
  content: Extract<Content, { type: "attachment" }>,
  replyToMessageId?: string
) => {
  const att = await attachmentContentToSdk(content);
  const kind = mimeToAttachmentKind(content.mimeType);
  const media: MediaInput = {
    data: att.data,
    mimeType: att.mimeType,
    filename: att.filename,
  };
  const base = {
    chatId: spaceId,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  };
  if (kind === "photo") {
    return await client.messages.send({ ...base, photo: media });
  }
  if (kind === "video") {
    return await client.messages.send({ ...base, video: media });
  }
  if (kind === "audio") {
    return await client.messages.send({ ...base, audio: media });
  }
  return await client.messages.send({ ...base, document: media });
};

export const send = async (
  clients: TelegramClients,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord | undefined> => {
  if (content.type === "reply") {
    return await replyToMessage(
      clients,
      spaceId,
      content.target.id,
      content.content
    );
  }
  if (content.type === "reaction") {
    await reactToMessage(clients, spaceId, content.target.id, content.emoji);
    return;
  }
  if (content.type === "typing") {
    // Best-effort "typing..." indicator. Telegram clears it after ~5s; the
    // app is expected to resend periodically for longer operations.
    await primary(clients)
      .messages.sendChatAction({ chatId: spaceId, action: "typing" })
      .catch(() => undefined);
    return;
  }
  const client = primary(clients);
  switch (content.type) {
    case "text":
      return toRecord(
        await client.messages.send({ chatId: spaceId, text: content.text }),
        spaceId,
        content
      );
    case "attachment":
      return toRecord(
        await sendAttachment(client, spaceId, content),
        spaceId,
        content
      );
    case "voice": {
      const media = await voiceContentToMedia(content);
      return toRecord(
        await client.messages.send({ chatId: spaceId, voice: media }),
        spaceId,
        content
      );
    }
    case "poll": {
      const sdkPoll = pollContentToSdk(content);
      const result = await client.messages.send({
        chatId: spaceId,
        poll: sdkPoll,
      });
      cachePoll(client, result.messageId, content);
      return toRecord(result, spaceId, content);
    }
    case "edit": {
      if (content.content.type !== "text") {
        throw UnsupportedError.action(
          "edit",
          "Telegram",
          "only text edits are supported via Content; use editMedia/editCaption on the SDK directly for media edits"
        );
      }
      return toRecord(
        await client.messages.edit({
          chatId: spaceId,
          messageId: content.target.id,
          text: content.content.text,
        }),
        spaceId,
        content
      );
    }
    default:
      throw UnsupportedError.content(content.type);
  }
};

const reactToMessage = async (
  clients: TelegramClients,
  spaceId: string,
  messageId: string,
  emoji: string
): Promise<void> => {
  await primary(clients).messages.react({
    chatId: spaceId,
    messageId,
    emoji: [emoji],
  });
};

export const replyToMessage = async (
  clients: TelegramClients,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const client = primary(clients);
  switch (content.type) {
    case "text":
      return toRecord(
        await client.messages.send({
          chatId: spaceId,
          text: content.text,
          replyToMessageId: messageId,
        }),
        spaceId,
        content
      );
    case "attachment":
      return toRecord(
        await sendAttachment(client, spaceId, content, messageId),
        spaceId,
        content
      );
    case "voice": {
      const media = await voiceContentToMedia(content);
      return toRecord(
        await client.messages.send({
          chatId: spaceId,
          voice: media,
          replyToMessageId: messageId,
        }),
        spaceId,
        content
      );
    }
    case "poll": {
      const sdkPoll = pollContentToSdk(content);
      const result = await client.messages.send({
        chatId: spaceId,
        poll: sdkPoll,
        replyToMessageId: messageId,
      });
      cachePoll(client, result.messageId, content);
      return toRecord(result, spaceId, content);
    }
    default:
      throw UnsupportedError.content(content.type);
  }
};
