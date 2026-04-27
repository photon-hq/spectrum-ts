import type { Attachment } from "../../content/attachment";
import type { Contact } from "../../content/contact";
import type { Group } from "../../content/group";
import type { Poll as SpectrumPoll } from "../../content/poll";
import type { Reaction } from "../../content/reaction";
import type { Richlink } from "../../content/richlink";
import type { Content } from "../../content/types";
import type { Voice } from "../../content/voice";
import type { SendResult } from "../../platform/types";
import { UnsupportedError } from "../../utils/errors";
import { toVCard } from "../../utils/vcard";
import type { LinkPreviewOptions, Message } from "./generated/types";
import type { TelegramClient } from "./runtime/client";
import type { TelegramRuntime } from "./types";

const PLATFORM_NAME = "Telegram";

// Telegram's `question` field caps at 300 chars, options at 100 chars each.
// Spectrum's `pollSchema` enforces 300 on title but doesn't enforce per-option
// limits, so we surface a clearer Telegram-specific error before the API would.
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

// Pinning `url` explicitly is what unlocks `prefer_large_media` — without an
// explicit url, Telegram ignores the size hint and may render a tiny thumbnail
// or no preview at all. Setting it turns a plain link into a big preview card,
// which is the whole point of a richlink.
const richlinkPreviewOptions = (url: string): LinkPreviewOptions => ({
  is_disabled: false,
  url,
  prefer_large_media: true,
  show_above_text: true,
});

// Telegram preview cards are produced by a server-side scraper that fetches
// the URL itself and parses Open Graph / Twitter Card / oEmbed metadata —
// `sendMessage` exposes no input fields for `title`, `description`, or
// `image`, only layout knobs (size, position, on/off). That means
// `Richlink.title` / `Richlink.summary` / `Richlink.cover` are intentionally
// dropped on Telegram: there is no API to inject them, and faking it via
// HTML parse_mode would either lose the rich card (Option B in the design
// notes) or double-display caller text alongside the scraped card while
// complicating cover handling (Option C).
//
// Cross-platform fan-out trade-off: a caller setting `title`/`summary`/`cover`
// will see those honored on iMessage / WhatsApp Business but see Telegram's
// scraped metadata instead. This is documented in `bot-api-spec/README.md`
// under "Scope".
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
  // vCard enrichment is an optional decoration on top of Telegram's required
  // phone+first_name fields. If serialization fails for any reason (bad raw
  // payload, encoding edge case, etc.), fall back to sending the contact
  // without the `vcard` field rather than aborting the whole message.
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

const sendReactionContent = async (
  client: TelegramClient,
  spaceId: string,
  reaction: Reaction
): Promise<SendResult> => {
  const targetId = reaction.target.id;
  await client.invoke("setMessageReaction", {
    chat_id: toChatId(spaceId),
    message_id: toMessageId(targetId),
    // Telegram setMessageReaction overwrites the bot's reaction set on this
    // message. Sending a single-element array matches Spectrum's add-only
    // reaction model; callers wanting to clear should pass an empty string
    // through reactToMessage (we already handle that case there).
    reaction: [{ type: "emoji", emoji: reaction.emoji }],
  });
  return { id: targetId, timestamp: new Date() };
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

// Outbound poll send. Inbound poll *bodies* are mapped to Spectrum's `poll`
// content in events.ts via `pollFromTelegramPoll`. Inbound `poll_answer`
// updates (per-vote deltas) and `poll` updates (aggregate state) are
// intentionally not mapped to `poll_option` — that requires a per-poll cache
// (`poll_answer` omits chat and message ids), which we don't ship from the
// provider. Callers wanting per-vote events should subscribe to the raw
// client.
const sendPollContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  poll: SpectrumPoll,
  opts: SendOpts
): Promise<SendResult> => {
  validatePollOptionTitles(poll);
  const message = await runtime.client.invoke("sendPoll", {
    chat_id: toChatId(spaceId),
    question: poll.title,
    options: poll.options.map((o) => ({ text: o.title })),
    ...replyParams(opts),
  });
  return toSendResult(message);
};

// Telegram's Bot API has `sendMediaGroup` for native album sends, but it only
// accepts homogeneous photo+video / audio / document bundles modelled through
// `InputMediaPhoto` / `InputMediaVideo` etc., which our spec does not yet
// cover. For now we ship the universal fallback used by other providers
// (iMessage remote): iterate the group's items, dispatch each one through the
// normal send pipeline, and report per-item receipts via `groupMembers` so
// the platform layer can hydrate `outbound.content.items[i].id` for
// per-child reactions / replies.
//
// Trade-off: items arrive in Telegram as separate messages instead of a
// single album. Caller-visible semantics are preserved (each item is its
// own Message with a real id) and any mix of types is supported. A native
// `sendMediaGroup` fast-path can be added later behind the same surface
// without changing this function's contract.
const sendGroupContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  group: Group,
  opts: SendOpts
): Promise<SendResult> => {
  const groupMembers: SendResult[] = [];
  // Reply-parent only attaches to the first child: Telegram threads a single
  // reply edge per message, and "all children reply to the same parent"
  // would clutter the chat without adding meaning.
  let firstOpts: SendOpts = opts;
  for (const item of group.items) {
    const child = item.content;
    if (child.type === "group" || child.type === "reaction") {
      throw UnsupportedError.content(
        child.type,
        PLATFORM_NAME,
        `nested ${child.type} inside group is not allowed`
      );
    }
    groupMembers.push(await dispatchSend(runtime, spaceId, child, firstOpts));
    firstOpts = {};
  }
  const first = groupMembers[0];
  if (!first) {
    throw new Error("Telegram group send: empty items");
  }
  return { ...first, groupMembers };
};

const dispatchSend = async (
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content,
  opts: SendOpts
): Promise<SendResult> => {
  const client = runtime.client;
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
    case "poll":
      return await sendPollContent(runtime, spaceId, content, opts);
    case "reaction":
      // Reactions bypass the normal send flow: Telegram's setMessageReaction
      // returns a boolean, not a Message, and the reaction carries its own
      // target. We surface the target's id in SendResult so callers don't
      // get a fabricated message id, and the timestamp is "now" since the
      // API offers no server-side reaction timestamp.
      return await sendReactionContent(client, spaceId, content);
    case "custom":
      throw UnsupportedError.content("custom", PLATFORM_NAME);
    case "group":
      return await sendGroupContent(runtime, spaceId, content, opts);
    case "poll_option":
      // `poll_option` is an inbound vote-event payload, not something a bot
      // emits. Telegram has no "vote on behalf of user" API — the closest
      // would be paid-bot vote forging, which Spectrum does not model.
      throw UnsupportedError.content(
        "poll_option",
        PLATFORM_NAME,
        "poll_option is an inbound-only content type"
      );
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
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content
): Promise<SendResult> => dispatchSend(runtime, spaceId, content, {});

export const replyToMessage = (
  runtime: TelegramRuntime,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<SendResult> =>
  dispatchSend(runtime, spaceId, content, {
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
      // Telegram polls in particular cannot be edited at all — the only
      // mutation `editMessageReplyMarkup` allows is on the inline keyboard,
      // not the poll body. Spectrum's universal `editMessage` contract for
      // polls is undefined, so we reject explicitly.
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
