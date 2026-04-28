import type { Attachment } from "../../content/attachment";
import type { Contact } from "../../content/contact";
import { asGroup, type Group } from "../../content/group";
import type { Poll as SpectrumPoll } from "../../content/poll";
import type { Reaction } from "../../content/reaction";
import type { Richlink } from "../../content/richlink";
import type { Content } from "../../content/types";
import type { Voice } from "../../content/voice";
import type { Message as SpectrumMessage } from "../../types/message";
import { UnsupportedError } from "../../utils/errors";
import { toVCard } from "../../utils/vcard";
import type { LinkPreviewOptions, Message } from "./generated/types";
import { messageCacheKey } from "./runtime/cache";
import type { TelegramClient } from "./runtime/client";
import type { TelegramMessage, TelegramRuntime } from "./types";

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

// Build a `TelegramMessage` record from a Bot API response and the original
// caller-supplied `Content`. The returned value is both:
//
//   - the `ProviderMessageRecord` returned to the platform layer (PR #38
//     unified `send` / `replyToMessage` to return a record so
//     `wrapProviderMessage("outbound")` can stitch outbound `OutboundMessage`s
//     through the same pipeline as inbound messages); and
//
//   - written through to the runtime's messages cache so `getMessage(id)`
//     for an id we just sent returns a real entry.
//
// `content` is the universal `Content` value the caller passed in (carrying
// any live closures for attachments/voice). We deliberately do NOT re-derive
// content from the API response: re-deriving an `attachment` would point its
// `read()` at Telegram's `getFile`/CDN, breaking caller expectations of "I
// sent these bytes; reading the cached message gives me those bytes back".
// Reusing the original content keeps closures cheap and faithful.
const buildOutboundSender = (
  from: NonNullable<Message["from"]>
): TelegramMessage["sender"] => {
  // Mirror the inbound `userToSender` shape exactly so consumers see the
  // same fields regardless of whether the message came from a poll update or
  // from our own send/reply API response.
  const sender: TelegramMessage["sender"] = {
    id: String(from.id),
    chatId: from.id,
    isBot: from.is_bot,
    firstName: from.first_name,
  };
  if (from.last_name !== undefined) {
    sender.lastName = from.last_name;
  }
  if (from.username !== undefined) {
    sender.username = from.username;
  }
  if (from.language_code !== undefined) {
    sender.languageCode = from.language_code;
  }
  return sender;
};

const recordOutbound = (
  runtime: TelegramRuntime,
  message: Message,
  content: Content
): TelegramMessage => {
  // Telegram echoes `from` for most outbound responses, but the Bot API
  // explicitly documents that `from` may be empty for messages sent to
  // channels (and for anonymous group-admin sends). When that happens, the
  // message is still ours — we fall back to the bot identity captured at
  // `createClient` time via `getMe`. This makes channel sends produce
  // proper records instead of throwing.
  const fromUser = message.from ?? runtime.me;
  const space: TelegramMessage["space"] = {
    id: String(message.chat.id),
    chatId: message.chat.id,
    type: message.chat.type,
    ...(message.chat.title === undefined ? {} : { title: message.chat.title }),
    ...(message.chat.username === undefined
      ? {}
      : { username: message.chat.username }),
  };
  const record: TelegramMessage = {
    id: String(message.message_id),
    content,
    sender: buildOutboundSender(fromUser),
    space,
    timestamp: new Date(message.date * 1000),
  };
  if (message.media_group_id !== undefined) {
    record.mediaGroupId = message.media_group_id;
  }
  if (message.caption !== undefined && content.type !== "text") {
    record.caption = message.caption;
  }
  runtime.cache.messages.set(messageCacheKey(space.id, record.id), record);
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

// Reactions are first-class outbound content but Telegram's
// `setMessageReaction` returns only a boolean, not a Message. To honour
// PR #38's "send returns ProviderMessageRecord" contract we synthesize a
// record that points back at the reaction target: id is the target
// message id, content echoes the input reaction, sender is the bot
// (captured at createClient time via getMe), and space is hydrated from
// the cached target if we have it, falling back to a getChat round-trip
// otherwise. Timestamp is "now" since the API offers no server-side
// reaction timestamp. The synthesized record is intentionally NOT written
// to `runtime.cache.messages` — there is no new message to remember; the
// original target is what callers `getMessage()` for.
const sendReactionContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  reaction: Reaction
): Promise<TelegramMessage> => {
  const targetId = reaction.target.id;
  await runtime.client.invoke("setMessageReaction", {
    chat_id: toChatId(spaceId),
    message_id: toMessageId(targetId),
    // Telegram setMessageReaction overwrites the bot's reaction set on this
    // message. Sending a single-element array matches Spectrum's add-only
    // reaction model; callers wanting to clear should pass an empty string
    // through reactToMessage (we already handle that case there).
    reaction: [{ type: "emoji", emoji: reaction.emoji }],
  });
  const cachedTarget = runtime.cache.messages.get(
    messageCacheKey(spaceId, targetId)
  );
  let space: TelegramMessage["space"];
  if (cachedTarget) {
    space = cachedTarget.space;
  } else {
    // Cold path: target isn't in cache (likely a stale reference from a
    // previous process). One getChat call hydrates a faithful space; this
    // happens at most once per cold reaction target and is well worth the
    // synthetic-record fidelity.
    const chat = await runtime.client.invoke("getChat", {
      chat_id: toChatId(spaceId),
    });
    space = {
      id: String(chat.id),
      chatId: chat.id,
      type: chat.type,
      ...(chat.title === undefined ? {} : { title: chat.title }),
      ...(chat.username === undefined ? {} : { username: chat.username }),
    };
  }
  return {
    id: targetId,
    content: reaction,
    sender: buildOutboundSender(runtime.me),
    space,
    timestamp: new Date(),
  };
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
// content in `./events/inbound.ts` via `pollFromTelegramPoll`. Inbound
// `poll_answer` updates are now mapped to per-vote `poll_option` events
// using the poll cache populated here — see `./events/polls.ts`. Telegram
// only delivers `poll_answer` for non-anonymous polls a bot sent itself,
// which is why `sendPoll` pins `is_anonymous: false` and we associate the
// returned `poll.id` with `(chatId, messageId, original Spectrum poll)` in
// the cache. `Update.poll` (aggregate state changes) remains unmapped —
// Spectrum has no "poll snapshot" content type.
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
    // Telegram defaults polls to anonymous (`is_anonymous: true`), and the
    // Bot API only delivers `poll_answer` updates for *non-anonymous* polls
    // sent by the bot itself. Spectrum's `poll_option` event surface
    // depends on those updates (see `events/polls.ts`), so we pin
    // `is_anonymous: false` here to keep the vote-diff pipeline functional.
    // Callers that want anonymous polls would have to bypass Spectrum's
    // poll content type and call the raw client directly.
    is_anonymous: false,
    ...replyParams(opts),
  });
  // Telegram echoes the freshly-created poll back as `Message.poll` with the
  // server-assigned `poll.id`. Vote-event resolution keys on that id, so the
  // cache write only happens here (the inbound poll-body mapper in
  // `events/inbound.ts` deliberately does NOT write — bots don't receive
  // `poll_answer` for polls sent by other clients in the chat).
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

// Telegram's Bot API has `sendMediaGroup` for native album sends, but it only
// accepts homogeneous photo+video / audio / document bundles modelled through
// `InputMediaPhoto` / `InputMediaVideo` etc., which our spec does not yet
// cover. For now we ship the universal fallback used by other providers
// Telegram's Bot API exposes `sendMediaGroup` for native albums, but it
// only supports homogeneous photo/video/audio/document buckets and rejects
// text/contact/poll mixed in. Since Spectrum's `group` is heterogeneous, we
// fall back to lazy iteration: dispatch each item through the normal send
// pipeline and report per-item records via `asGroup({ items: childRecords })`.
//
// Trade-off: items arrive in Telegram as separate messages instead of a
// single album bubble. Caller-visible semantics are preserved (each item is
// its own message with a real id) and any mix of types works. A
// `sendMediaGroup` fast-path could be added later behind the same surface.
//
// The parent record's id is the first child's id. Telegram has no native
// "album parent" concept and we don't synthesize one — picking the first
// child means a reply or reaction targeting the group resolves to the
// album's lead message (closest analog to "the group itself").

// Group items are typed as `Message[]` (the rich resolved type with
// `react()`/`reply()` methods) but at the provider layer we only have raw
// records — the platform-side `wrapProviderMessage("outbound")` /
// `wrapNestedContent` flow turns each item into a real `Message` after the
// group leaves the provider. The `asGroup` builder's `isMessage` Zod guard
// is structural (`id` + `content`), which our `TelegramMessage` satisfies.
//
// We localize the type-erasure here in a single named helper instead of
// scattering `as unknown as Message[]` casts at call sites: the helper's
// signature documents that the records are pre-wrap (no methods) and the
// platform layer is responsible for completing them. Callers pass the array
// through directly; the helper exists to keep the necessary cast in one
// reviewable place. Exported so `events/inbound.ts` can reuse the same
// erasure for inbound album coalescing.
export const toGroupItems = (records: TelegramMessage[]): SpectrumMessage[] =>
  records as unknown as SpectrumMessage[];
const sendGroupContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  group: Group,
  opts: SendOpts
): Promise<TelegramMessage> => {
  const childRecords: TelegramMessage[] = [];
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
    childRecords.push(await dispatchSend(runtime, spaceId, child, firstOpts));
    firstOpts = {};
  }
  const first = childRecords[0];
  if (!first) {
    throw new Error("Telegram group send: empty items");
  }
  // The platform layer's `wrapProviderMessage("outbound")` will turn each
  // raw provider record under `items` into a real OutboundMessage via
  // `wrapNestedContent`. The Zod `isMessage` guard is loose enough to
  // accept the bare record shape (id + content + space + timestamp), which
  // is exactly what `toGroupItems` documents.
  return {
    ...first,
    content: asGroup({ items: toGroupItems(childRecords) }),
  };
};

const dispatchSend = async (
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content,
  opts: SendOpts
): Promise<TelegramMessage> => {
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
    case "effect":
      // `effect` (PR #39) is iMessage-only — it wraps inner content with a
      // visual effect like "Slam" or "Confetti" that has no analog in the
      // Telegram Bot API. The platform layer's `__platform`-tagged content
      // walker (also from PR #39) routes effect-wrapped content here only
      // when the inner content's `__platform` doesn't match Telegram, but
      // we still need an explicit case for the union exhaustiveness check.
      throw UnsupportedError.content(
        "effect",
        PLATFORM_NAME,
        "effect is an iMessage-only content type"
      );
    default: {
      // Compile-time exhaustiveness: any future addition to the `Content`
      // union without a matching case above breaks this assignment. The
      // runtime branch only fires if a caller smuggles in a value that
      // bypasses the static type — we surface a generic "unknown" label
      // since the smuggled value's `type` field can't be trusted (no cast
      // to `{ type: string }` is sound here).
      content satisfies never;
      throw UnsupportedError.content("unknown", PLATFORM_NAME);
    }
  }
};

export const send = (
  runtime: TelegramRuntime,
  spaceId: string,
  content: Content
): Promise<TelegramMessage> => dispatchSend(runtime, spaceId, content, {});

export const replyToMessage = (
  runtime: TelegramRuntime,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<TelegramMessage> =>
  dispatchSend(runtime, spaceId, content, {
    replyToMessageId: toMessageId(messageId),
  });

export const editMessage = async (
  runtime: TelegramRuntime,
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
  // `editMessageText` returns the edited Message (or `true` for inline
  // messages — not relevant here since we always pass a chat_id). We don't
  // surface the return value to the caller (Spectrum's editMessage contract
  // is `void`), but we DO update the cache so a subsequent `getMessage`
  // returns the new content rather than the pre-edit version.
  const result = await runtime.client.invoke("editMessageText", {
    chat_id: toChatId(spaceId),
    message_id: targetId,
    text,
    ...(content.type === "richlink"
      ? { link_preview_options: richlinkPreviewOptions(content.url) }
      : {}),
  });
  if (typeof result !== "boolean") {
    recordOutbound(runtime, result, content);
  }
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
