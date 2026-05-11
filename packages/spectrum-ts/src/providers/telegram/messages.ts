import type { Attachment } from "../../content/attachment";
import type { Contact } from "../../content/contact";
import type { Edit } from "../../content/edit";
import { asGroup, type Group } from "../../content/group";
import type { Poll as SpectrumPoll } from "../../content/poll";
import type { Reaction } from "../../content/reaction";
import type { Reply } from "../../content/reply";
import type { Richlink } from "../../content/richlink";
import type { Content } from "../../content/types";
import type { Typing } from "../../content/typing";
import type { Voice } from "../../content/voice";
import type { Message as SpectrumMessage } from "../../types/message";
import { UnsupportedError } from "../../utils/errors";
import { toVCard } from "../../utils/vcard";
import type { LinkPreviewOptions, Message } from "./generated/types";
import { chatToSender, chatToSpace, userToSender } from "./identity";
import { messageCacheKey } from "./runtime/cache";
import type { TelegramMessage, TelegramRuntime } from "./types";

const PLATFORM_NAME = "Telegram";

// Telegram caps poll option text at 100 chars; pollSchema doesn't.
const TG_POLL_OPTION_MAX_LEN = 100;

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

// Builds the outbound record returned to the platform layer and cached
// for `getMessage`. We carry the caller's original `Content` through
// instead of re-deriving from the API response so attachment / voice
// closures still point at the caller's bytes, not a fresh `getFile` URL.
const recordOutbound = (
  runtime: TelegramRuntime,
  message: Message,
  content: Content
): TelegramMessage => {
  // Sender selection mirrors the inbound path:
  //   `from` (regular user) → `sender_chat` (channel / anon admin) →
  //   `runtime.me` (bot itself) as a last-resort fallback.
  let sender: TelegramMessage["sender"];
  if (message.from) {
    sender = userToSender(message.from);
  } else if (message.sender_chat) {
    sender = chatToSender(message.sender_chat);
  } else {
    sender = userToSender(runtime.me);
  }
  const record: TelegramMessage = {
    id: String(message.message_id),
    content,
    sender,
    space: chatToSpace(message.chat),
    timestamp: new Date(message.date * 1000),
  };
  if (message.media_group_id !== undefined) {
    record.mediaGroupId = message.media_group_id;
  }
  if (message.caption !== undefined && content.type !== "text") {
    record.caption = message.caption;
  }
  runtime.cache.messages.set(
    messageCacheKey(record.space.id, record.id),
    record
  );
  return record;
};

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

// `sendPhoto` only reliably accepts JPEG / PNG / WEBP; other image
// subtypes get rejected with opaque "WRONG_FILE_FORMAT" errors. Everything
// else falls through to `sendDocument`, which has no MIME constraints.
const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const routeAttachment = (mime: string): AttachmentRoute => {
  if (PHOTO_MIME_TYPES.has(mime)) {
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
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content & { type: "text" },
  opts: SendOpts
): Promise<TelegramMessage> => {
  const message = await runtime.client.invoke("sendMessage", {
    chat_id: toChatId(spaceId),
    text: content.text,
    ...replyParams(opts),
  });
  return recordOutbound(runtime, message, content);
};

// `prefer_large_media` only takes effect when `url` is pinned explicitly;
// without it Telegram falls back to a tiny thumbnail or no preview.
const richlinkPreviewOptions = (url: string): LinkPreviewOptions => ({
  is_disabled: false,
  url,
  prefer_large_media: true,
  show_above_text: true,
});

// Preview cards are produced by Telegram's server-side scraper. The Bot API
// exposes only layout knobs (size, position, on/off), so caller-provided
// `title` / `summary` / `cover` cannot be injected and are dropped here.
const sendRichlinkContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  richlink: Richlink,
  opts: SendOpts
): Promise<TelegramMessage> => {
  const message = await runtime.client.invoke("sendMessage", {
    chat_id: toChatId(spaceId),
    text: richlink.url,
    link_preview_options: richlinkPreviewOptions(richlink.url),
    ...replyParams(opts),
  });
  return recordOutbound(runtime, message, richlink);
};

const sendAttachment = async (
  runtime: TelegramRuntime,
  spaceId: string,
  att: Attachment,
  opts: SendOpts
): Promise<TelegramMessage> => {
  const chat_id = toChatId(spaceId);
  const file = await attachmentToFile(att);
  const reply = replyParams(opts);
  const route = routeAttachment(att.mimeType);
  const client = runtime.client;

  let message: Message;
  switch (route) {
    case "photo":
      message = await client.invoke("sendPhoto", {
        chat_id,
        photo: file,
        ...reply,
      });
      break;
    case "video":
      message = await client.invoke("sendVideo", {
        chat_id,
        video: file,
        ...reply,
      });
      break;
    case "audio":
      message = await client.invoke("sendAudio", {
        chat_id,
        audio: file,
        ...reply,
      });
      break;
    case "document":
      message = await client.invoke("sendDocument", {
        chat_id,
        document: file,
        ...reply,
      });
      break;
    default: {
      const _exhaustive: never = route;
      throw new Error(`Unhandled attachment route: ${String(_exhaustive)}`);
    }
  }
  return recordOutbound(runtime, message, att);
};

const sendVoiceContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  voice: Voice,
  opts: SendOpts
): Promise<TelegramMessage> => {
  const file = await voiceFile(voice);
  const message = await runtime.client.invoke("sendVoice", {
    chat_id: toChatId(spaceId),
    voice: file,
    ...(voice.duration === undefined
      ? {}
      : { duration: Math.round(voice.duration) }),
    ...replyParams(opts),
  });
  return recordOutbound(runtime, message, voice);
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
  // vCard is optional decoration on top of the required phone+first_name;
  // fall back to a plain contact if serialization fails.
  let card: string;
  try {
    card = await toVCard(contact);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(card, "utf8") > VCARD_MAX_BYTES) {
    return undefined;
  }
  return card;
};

const sendContactContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  contact: Contact,
  opts: SendOpts
): Promise<TelegramMessage> => {
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
  const message = await runtime.client.invoke("sendContact", params);
  return recordOutbound(runtime, message, contact);
};

// `setMessageReaction` returns a boolean (not a Message) so we return
// `undefined` per the fire-and-forget contract. The single-element
// `reaction` array overwrites any prior bot reaction with this emoji;
// passing `[]` would clear, which the current schema doesn't model.
const sendReactionContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  reaction: Reaction
): Promise<undefined> => {
  await runtime.client.invoke("setMessageReaction", {
    chat_id: toChatId(spaceId),
    message_id: toMessageId(reaction.target.id),
    reaction: [{ type: "emoji", emoji: reaction.emoji }],
  });
  return;
};

const validatePollOptionTitles = (poll: SpectrumPoll): void => {
  for (const opt of poll.options) {
    if (opt.title.length > TG_POLL_OPTION_MAX_LEN) {
      throw new Error(
        `Telegram poll option titles must be <= ${TG_POLL_OPTION_MAX_LEN} chars, got ${opt.title.length}: "${opt.title.slice(0, 32)}…"`
      );
    }
  }
};

// `is_anonymous: false` is required: Telegram only delivers `poll_answer`
// for non-anonymous polls the bot itself sent, and our `poll_option`
// event stream depends on those updates. Anonymous polls aren't reachable
// through this surface today.
const sendPollContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  poll: SpectrumPoll,
  opts: SendOpts
): Promise<TelegramMessage> => {
  validatePollOptionTitles(poll);
  const message = await runtime.client.invoke("sendPoll", {
    chat_id: toChatId(spaceId),
    question: poll.title,
    options: poll.options.map((o) => ({ text: o.title })),
    is_anonymous: false,
    ...replyParams(opts),
  });
  // Cache the server-assigned `poll.id` so `poll_answer` events can
  // resolve back to the original Spectrum poll.
  if (message.poll) {
    runtime.cache.polls.rememberPoll(message.poll.id, {
      chat: {
        id: String(message.chat.id),
        chatId: message.chat.id,
        type: message.chat.type,
        ...(message.chat.title === undefined
          ? {}
          : { title: message.chat.title }),
        ...(message.chat.username === undefined
          ? {}
          : { username: message.chat.username }),
      },
      messageId: message.message_id,
      poll,
    });
  }
  return recordOutbound(runtime, message, poll);
};

// Telegram's native `sendMediaGroup` only accepts homogeneous photo /
// video / audio / document buckets; Spectrum `group` is heterogeneous, so
// we fall back to iterating children through the normal send pipeline.
// The wrapper's id is the lead child's id so replies / reactions target
// the album's first message.

// `as unknown as SpectrumMessage[]` is correct here: the platform's
// `wrapProviderMessage` adds the `react()` / `reply()` closures during
// inflation; provider-side records intentionally lack them.
export const toGroupItems = (records: TelegramMessage[]): SpectrumMessage[] =>
  records as unknown as SpectrumMessage[];

const sendGroupContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  group: Group,
  opts: SendOpts
): Promise<TelegramMessage> => {
  // Pre-validate every child so we don't push half an album to Telegram
  // and then throw on a later one (no atomic undo). Validation order
  // matches `dispatchSend`'s rejections so error messages are unchanged.
  for (const item of group.items) {
    const child = item.content;
    if (child.type === "group" || child.type === "reaction") {
      throw UnsupportedError.content(
        child.type,
        PLATFORM_NAME,
        `nested ${child.type} inside group is not allowed`
      );
    }
    if (
      child.type === "reply" ||
      child.type === "edit" ||
      child.type === "typing"
    ) {
      throw UnsupportedError.content(
        child.type,
        PLATFORM_NAME,
        `${child.type} cannot be an album member`
      );
    }
    if (child.type === "custom") {
      throw UnsupportedError.content("custom", PLATFORM_NAME);
    }
    if (child.type === "poll_option") {
      throw UnsupportedError.content(
        "poll_option",
        PLATFORM_NAME,
        "poll_option is an inbound-only content type"
      );
    }
    if (child.type === "effect") {
      throw UnsupportedError.content(
        "effect",
        PLATFORM_NAME,
        "effect is an iMessage-only content type"
      );
    }
  }

  const childRecords: TelegramMessage[] = [];
  // Reply-parent attaches to the first child only; Telegram threads a
  // single reply edge per message.
  let firstOpts: SendOpts = opts;
  for (const item of group.items) {
    const child = item.content;
    const childRecord = await dispatchSend(runtime, spaceId, child, firstOpts);
    if (!childRecord) {
      throw new Error(
        `Telegram group send: child of type "${child.type}" did not produce a message`
      );
    }
    childRecords.push(childRecord);
    firstOpts = {};
  }
  const first = childRecords[0];
  if (!first) {
    throw new Error("Telegram group send: empty items");
  }
  const wrapper: TelegramMessage = {
    ...first,
    content: asGroup({ items: toGroupItems(childRecords) }),
  };
  // The wrapper shares the lead child's id; overwrite the per-child cache
  // entry so `getMessage(wrapper.id)` matches what `send` returned.
  runtime.cache.messages.set(
    messageCacheKey(first.space.id, wrapper.id),
    wrapper
  );
  return wrapper;
};

// `editMessageText` only edits text bodies (with optional preview
// metadata). Telegram has no edit endpoint for media payloads or polls.
const sendEditContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  editContent: Edit
): Promise<undefined> => {
  const inner = editContent.content;
  if (inner.type !== "text" && inner.type !== "richlink") {
    throw UnsupportedError.content(
      "edit",
      PLATFORM_NAME,
      `only text/richlink edits are supported, got "${inner.type}"`
    );
  }
  const text = inner.type === "text" ? inner.text : inner.url;
  // `editMessageText` returns the edited Message (boolean only for inline
  // messages, which we never use). Refresh the cache so a subsequent
  // `getMessage` returns the post-edit record.
  const result = await runtime.client.invoke("editMessageText", {
    chat_id: toChatId(spaceId),
    message_id: toMessageId(editContent.target.id),
    text,
    ...(inner.type === "richlink"
      ? { link_preview_options: richlinkPreviewOptions(inner.url) }
      : {}),
  });
  if (typeof result !== "boolean") {
    recordOutbound(runtime, result, inner);
  }
  return;
};

// `sendChatAction` is one-shot; Telegram auto-expires the indicator after
// ~5s and has no "cancel typing" counterpart, so `stop` is a no-op.
const sendTypingContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  typing: Typing
): Promise<undefined> => {
  if (typing.state === "start") {
    await runtime.client.invoke("sendChatAction", {
      chat_id: toChatId(spaceId),
      action: "typing",
    });
  }
  return;
};

// Unwraps and dispatches the inner content with `reply_parameters`
// threaded via `SendOpts`. The `reply()` builder already gates inner
// shapes so no extra runtime guard is needed here.
const sendReplyContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  replyContent: Reply
): Promise<TelegramMessage | undefined> =>
  await dispatchSend(runtime, spaceId, replyContent.content, {
    replyToMessageId: toMessageId(replyContent.target.id),
  });

const dispatchSend = async (
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content,
  opts: SendOpts
): Promise<TelegramMessage | undefined> => {
  switch (content.type) {
    case "text":
      return await sendText(runtime, spaceId, content, opts);
    case "richlink":
      return await sendRichlinkContent(runtime, spaceId, content, opts);
    case "attachment":
      return await sendAttachment(runtime, spaceId, content, opts);
    case "voice":
      return await sendVoiceContent(runtime, spaceId, content, opts);
    case "contact":
      return await sendContactContent(runtime, spaceId, content, opts);
    case "poll":
      return await sendPollContent(runtime, spaceId, content, opts);
    case "reaction":
      return await sendReactionContent(runtime, spaceId, content);
    case "reply":
      return await sendReplyContent(runtime, spaceId, content);
    case "edit":
      return await sendEditContent(runtime, spaceId, content);
    case "typing":
      return await sendTypingContent(runtime, spaceId, content);
    case "custom":
      throw UnsupportedError.content("custom", PLATFORM_NAME);
    case "group":
      return await sendGroupContent(runtime, spaceId, content, opts);
    case "poll_option":
      throw UnsupportedError.content(
        "poll_option",
        PLATFORM_NAME,
        "poll_option is an inbound-only content type"
      );
    case "effect":
      throw UnsupportedError.content(
        "effect",
        PLATFORM_NAME,
        "effect is an iMessage-only content type"
      );
    default: {
      content satisfies never;
      throw UnsupportedError.content("unknown", PLATFORM_NAME);
    }
  }
};

export const send = (
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content
): Promise<TelegramMessage | undefined> =>
  dispatchSend(runtime, spaceId, content, {});
