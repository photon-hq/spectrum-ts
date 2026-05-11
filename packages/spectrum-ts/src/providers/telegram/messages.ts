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
//   - the `ProviderMessageRecord` returned to the platform layer (PR #55
//     collapsed the provider surface to a single `send` action; outbound
//     records produced here flow through `wrapProviderMessage("outbound")`
//     and become real `OutboundMessage`s via the same pipeline as inbound
//     messages); and
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
const recordOutbound = (
  runtime: TelegramRuntime,
  message: Message,
  content: Content
): TelegramMessage => {
  // Sender selection mirrors the inbound flow precisely (see
  // `events/inbound.ts:toTelegramMessage`) by reusing the same `userToSender`
  // and `chatToSender` mappers from `../identity`:
  //   1. `from` (regular user account, including bots) — most common case.
  //   2. `sender_chat` (channel post / anonymous-admin send on behalf of a
  //      group) — Bot API populates this when `from` is omitted; the
  //      channel is the canonical author and must be reflected as such.
  //   3. `runtime.me` (the bot itself) — last-resort fallback for the rare
  //      case where Telegram returns neither field. Without this the
  //      record would have no sender, and `TelegramMessage["sender"]` is
  //      required by Spectrum's universal contract.
  // The earlier shortcut `message.from ?? runtime.me` would silently
  // rewrite channel posts as bot-authored, breaking the round-trip
  // identity invariant: a message we send to a channel should appear in
  // the cache with the channel as sender, the same way the inbound stream
  // would have surfaced it.
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

// `sendPhoto` only reliably accepts JPEG / PNG / WEBP. Other image MIME
// types (HEIC, SVG, TIFF, AVIF, BMP, ICO, …) get silently rejected with
// inscrutable "PHOTO_INVALID_DIMENSIONS" / "WRONG_FILE_FORMAT" errors —
// route those through `sendDocument` instead so the file ships intact and
// the recipient can still open it. The `image/gif` case is already
// handled (Telegram has separate animation semantics; sendPhoto rejects).
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
  // Everything else (other image/* subtypes, application/*, text/*, …)
  // falls through to `sendDocument`, which is Telegram's universal
  // file-send endpoint with no MIME constraints.
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
// scraped metadata instead. This is documented in
// `./bot-api-spec/README.md` under "Scope".
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
// `setMessageReaction` returns only a boolean, not a Message — and PR #55
// removed the requirement that fire-and-forget content types synthesize
// a record. We simply post the reaction and return `undefined`, which the
// platform layer interprets as "no new outbound message". The original
// target stays addressable via `space.getMessage(id)` for callers that
// need to inspect the message they reacted to.
const sendReactionContent = async (
  runtime: TelegramRuntime,
  spaceId: string,
  reaction: Reaction
): Promise<undefined> => {
  await runtime.client.invoke("setMessageReaction", {
    chat_id: toChatId(spaceId),
    message_id: toMessageId(reaction.target.id),
    // Telegram setMessageReaction overwrites the bot's reaction set on this
    // message. Sending a single-element array matches Spectrum's add-only
    // reaction model; an empty array would clear, which Spectrum does not
    // currently model on the `reaction` content type.
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
  // Pre-validate the entire group BEFORE posting any child. Without this,
  // a heterogeneous group like `[photo, reaction, contact]` would push
  // `photo` to Telegram first, *then* throw when it reached `reaction` —
  // leaving an orphan media message in the chat with no group context and
  // no way to atomically undo the send. We catch every type `dispatchSend`
  // throws on synchronously (the same set, in the same order, so the
  // user-facing error message is identical to what they'd see today; only
  // the *timing* of the throw moves).
  for (const item of group.items) {
    const child = item.content;
    if (child.type === "group" || child.type === "reaction") {
      throw UnsupportedError.content(
        child.type,
        PLATFORM_NAME,
        `nested ${child.type} inside group is not allowed`
      );
    }
    // Reply / edit / typing inside a group make no sense as album members:
    // edits and typing indicators aren't messages, and Telegram threads
    // exactly one reply edge per message (the first child) so distributing
    // a single target across N members would silently lose information.
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
    // Mirror the explicit `dispatchSend` rejections for these types so the
    // user-facing error and detail string are identical — only the *timing*
    // of the throw moves earlier (before any child is posted).
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
  // Reply-parent only attaches to the first child: Telegram threads a single
  // reply edge per message, and "all children reply to the same parent"
  // would clutter the chat without adding meaning.
  let firstOpts: SendOpts = opts;
  for (const item of group.items) {
    const child = item.content;
    const childRecord = await dispatchSend(runtime, spaceId, child, firstOpts);
    if (!childRecord) {
      // Defensive: pre-validation above rejects every fire-and-forget child
      // type that would return `undefined`, so this branch only fires if a
      // future content type slips through. Bail loudly rather than push a
      // partial album with phantom members.
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
  // The platform layer's `wrapProviderMessage("outbound")` will turn each
  // raw provider record under `items` into a real OutboundMessage via
  // `wrapNestedContent`. The Zod `isMessage` guard is loose enough to
  // accept the bare record shape (id + content + space + timestamp), which
  // is exactly what `toGroupItems` documents.
  const wrapper: TelegramMessage = {
    ...first,
    content: asGroup({ items: toGroupItems(childRecords) }),
  };
  // Replace the lead child's individual cache entry with the group
  // wrapper so `getMessage(first.id)` returns the same value the caller
  // got back from `send`. Without this overwrite, the wrapper and the
  // first child collide on `first.id`: `dispatchSend` already wrote the
  // child via `recordOutbound`, so the cache would still resolve to the
  // child's text/media content rather than the `group` content the
  // wrapper carries. The remaining children stay individually addressable
  // under their own ids (album members can still be replied to / reacted
  // to one-by-one).
  runtime.cache.messages.set(
    messageCacheKey(first.space.id, wrapper.id),
    wrapper
  );
  return wrapper;
};

// `edit` ultimately fans out through `editMessageText`. The wire API only
// supports replacing the body text (with optional link-preview metadata)
// of a previously-sent message; Telegram has no general "edit anything"
// endpoint (no edit for media payloads or polls). Other content types are
// rejected with `UnsupportedError.content` so the dispatch surface is
// consistent with how iMessage / WhatsApp report missing capabilities.
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
      // Telegram polls in particular cannot be edited at all — the only
      // mutation `editMessageReplyMarkup` allows is on the inline keyboard,
      // not the poll body. Reject other types explicitly so callers get a
      // clear message instead of a Bad Request from Telegram.
      `only text/richlink edits are supported, got "${inner.type}"`
    );
  }
  const text = inner.type === "text" ? inner.text : inner.url;
  // `editMessageText` returns the edited Message (or `true` for inline
  // messages — not relevant here since we always pass a chat_id). We don't
  // surface the return value (per the new `send()` fire-and-forget contract
  // for edits), but we DO update the cache so a subsequent `getMessage`
  // returns the new content rather than the pre-edit version.
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

// Telegram's `sendChatAction` is a one-shot indicator that the server
// auto-expires after ~5 seconds; the Bot API has no "cancel typing"
// counterpart. We post the action on `start` and silently no-op on
// `stop` — the server-side timeout takes care of dismissing the indicator
// naturally. Returning `undefined` matches the fire-and-forget contract.
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

// `reply` is sugar over the regular send pipeline: peel the wrapper off
// and dispatch the inner content with the target message id stashed in
// `SendOpts.replyToMessageId` so the per-type send helpers attach
// Telegram's `reply_parameters`. Inner content shapes are gated by the
// builder (`reply()` rejects nested reply/edit/reaction/group/typing), so
// we don't add a runtime guard here — the schema accepts a wider
// `BaseContent` only to break a circular type alias, not to widen the
// real surface.
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
): Promise<TelegramMessage | undefined> =>
  dispatchSend(runtime, spaceId, content, {});
