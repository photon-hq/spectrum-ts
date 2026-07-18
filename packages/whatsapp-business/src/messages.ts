import type {
  ContactCard,
  ContactCardInput,
  InboundMessage,
  TemplateInput,
  WhatsAppClient,
} from "@photon-ai/whatsapp-business";
import {
  type Contact,
  type Content,
  type Group,
  type ManagedStream,
  mergeStreams,
  type Poll,
  type Reaction,
  type ContactAddress as SpectrumContactAddress,
  type ContactEmail as SpectrumContactEmail,
  type ContactName as SpectrumContactName,
  type ContactOrg as SpectrumContactOrg,
  type ContactPhone as SpectrumContactPhone,
  type Message as SpectrumMessage,
  stream,
  UnsupportedError,
} from "@spectrum-ts/core";
import {
  asAttachment,
  asContact,
  asCustom,
  asGroup,
  asPollOption,
  asReaction,
  asReply,
  asText,
  asUnsend,
  asVoice,
  createLogger,
  errorAttrs,
  type ProviderMessageRecord,
  tracedFetch,
} from "@spectrum-ts/core/authoring";
import { extension as mimeExtension } from "mime-types";
import { isWhatsAppTemplate, type WhatsAppTemplate } from "./content/template";
import { WhatsAppPartialSendError } from "./errors/partial-send";
import { pollOptionId, pollToInteractive } from "./poll";
import type { WhatsAppClients, WhatsAppMessage } from "./types";

// v1 routes outbound traffic to the first line. When multi-line send becomes a
// requirement, extend spaceSchema with an optional `line` (phoneNumberId) and
// pick the matching client here.
const primary = (clients: WhatsAppClients): WhatsAppClient => {
  const client = clients[0];
  if (!client) {
    throw new Error("No WhatsApp Business client available");
  }
  return client;
};

type WaSendResult = Awaited<ReturnType<WhatsAppClient["messages"]["send"]>>;

type ContentOfType<T extends Content["type"]> = Extract<Content, { type: T }>;

const toRecord = (
  result: WaSendResult,
  spaceId: string,
  content: Content
): ProviderMessageRecord => ({
  id: result.messageId,
  content,
  space: { id: spaceId },
  timestamp: new Date(),
});

const MAX_POLL_CACHE_SIZE = 1000;
const OPTION_ID_PREFIX = "opt_";
const pollCaches = new WeakMap<WhatsAppClient, Map<string, Poll>>();

const getPollCache = (client: WhatsAppClient): Map<string, Poll> => {
  let cache = pollCaches.get(client);
  if (!cache) {
    cache = new Map<string, Poll>();
    pollCaches.set(client, cache);
  }
  return cache;
};

const cachePoll = (
  client: WhatsAppClient,
  messageId: string,
  poll: Poll
): void => {
  const cache = getPollCache(client);
  if (cache.has(messageId)) {
    cache.delete(messageId);
  }
  cache.set(messageId, poll);
  if (cache.size > MAX_POLL_CACHE_SIZE) {
    const first = cache.keys().next().value;
    if (first !== undefined) {
      cache.delete(first);
    }
  }
};

interface CachedReaction {
  emoji: string;
  id: string;
}
const MAX_REACTION_CACHE_SIZE = 1000;
const reactionCaches = new WeakMap<
  WhatsAppClient,
  Map<string, CachedReaction>
>();

const reactionCacheKey = (reactedId: string, from: string): string =>
  `${reactedId}:${from}`;

const cacheReaction = (
  client: WhatsAppClient,
  reactedId: string,
  from: string,
  entry: CachedReaction
): void => {
  let cache = reactionCaches.get(client);
  if (!cache) {
    cache = new Map<string, CachedReaction>();
    reactionCaches.set(client, cache);
  }
  const key = reactionCacheKey(reactedId, from);
  // Delete-then-set keeps a re-reaction fresh in LRU order.
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_REACTION_CACHE_SIZE) {
    const first = cache.keys().next().value;
    if (first !== undefined) {
      cache.delete(first);
    }
  }
};

const getCachedReaction = (
  client: WhatsAppClient,
  reactedId: string,
  from: string
): CachedReaction | undefined =>
  reactionCaches.get(client)?.get(reactionCacheKey(reactedId, from));

const reactionTargetStub = (reactedId: string) => ({
  id: reactedId,
  content: asCustom({ whatsapp_type: "reaction-target", stub: true }),
});

// The Cloud API has no endpoint to fetch a message by wamid, so a quoted
// reply's target degrades to a stub carrying just the id — same trade-off as
// reactionTargetStub.
const replyTargetStub = (quotedId: string) => ({
  id: quotedId,
  content: asCustom({ whatsapp_type: "reply-target", stub: true }),
});

// context.id does not always mean the user quoted a message: interactive and
// button events carry it to reference the tapped interactive/template message
// (poll votes resolve it against the poll cache instead), and reaction events
// target a message rather than quote one.
const REPLY_EXEMPT_TYPES = new Set(["interactive", "button", "reaction"]);

// asReply (schema-level) rather than the reply() builder: inbound captioned
// media maps to a group, which the builder rejects but the schema accepts.
const withReplyContext = (msg: InboundMessage, content: Content): Content => {
  const quotedId = msg.context?.id;
  if (quotedId === undefined || REPLY_EXEMPT_TYPES.has(msg.content.type)) {
    return content;
  }
  return asReply({
    content: content as Parameters<typeof asReply>[0]["content"],
    target: replyTargetStub(quotedId) as Parameters<
      typeof asReply
    >[0]["target"],
  });
};

const optionIndexFromId = (id: string): number | undefined => {
  if (!id.startsWith(OPTION_ID_PREFIX)) {
    return;
  }
  const index = Number(id.slice(OPTION_ID_PREFIX.length));
  if (!Number.isInteger(index) || index < 0 || pollOptionId(index) !== id) {
    return;
  }
  return index;
};

type WaContactName = ContactCard["name"];
type WaContactPhone = ContactCard["phones"][number];
type WaContactEmail = ContactCard["emails"][number];
type WaContactAddress = ContactCard["addresses"][number];
type WaContactOrg = NonNullable<ContactCard["org"]>;
type WaContactUrl = ContactCard["urls"][number];

const mapWaPhoneType = (
  type: string | undefined
): SpectrumContactPhone["type"] => {
  if (!type) {
    return;
  }
  const upper = type.toUpperCase();
  if (upper === "CELL" || upper === "MOBILE" || upper === "IPHONE") {
    return "mobile";
  }
  if (upper === "HOME") {
    return "home";
  }
  if (upper === "WORK" || upper === "BUSINESS") {
    return "work";
  }
  return "other";
};

const mapWaSimpleType = (
  type: string | undefined
): "home" | "work" | "other" | undefined => {
  if (!type) {
    return;
  }
  const upper = type.toUpperCase();
  if (upper === "HOME") {
    return "home";
  }
  if (upper === "WORK" || upper === "BUSINESS") {
    return "work";
  }
  return "other";
};

const waNameToSpectrum = (name: WaContactName): SpectrumContactName => {
  const result: SpectrumContactName = { formatted: name.formattedName };
  if (name.firstName) {
    result.first = name.firstName;
  }
  if (name.lastName) {
    result.last = name.lastName;
  }
  if (name.middleName) {
    result.middle = name.middleName;
  }
  if (name.prefix) {
    result.prefix = name.prefix;
  }
  if (name.suffix) {
    result.suffix = name.suffix;
  }
  return result;
};

const waPhoneToSpectrum = (phone: WaContactPhone): SpectrumContactPhone => {
  const entry: SpectrumContactPhone = { value: phone.phone };
  const type = mapWaPhoneType(phone.type);
  if (type) {
    entry.type = type;
  }
  return entry;
};

const waEmailToSpectrum = (email: WaContactEmail): SpectrumContactEmail => {
  const entry: SpectrumContactEmail = { value: email.email };
  const type = mapWaSimpleType(email.type);
  if (type) {
    entry.type = type;
  }
  return entry;
};

const waAddressToSpectrum = (
  address: WaContactAddress
): SpectrumContactAddress => {
  const entry: SpectrumContactAddress = {};
  if (address.street) {
    entry.street = address.street;
  }
  if (address.city) {
    entry.city = address.city;
  }
  if (address.state) {
    entry.region = address.state;
  }
  if (address.zip) {
    entry.postalCode = address.zip;
  }
  if (address.country) {
    entry.country = address.country;
  }
  const type = mapWaSimpleType(address.type);
  if (type) {
    entry.type = type;
  }
  return entry;
};

const waOrgToSpectrum = (org: WaContactOrg): SpectrumContactOrg => {
  const entry: SpectrumContactOrg = {};
  if (org.company) {
    entry.name = org.company;
  }
  if (org.title) {
    entry.title = org.title;
  }
  if (org.department) {
    entry.department = org.department;
  }
  return entry;
};

const waContactToSpectrum = (card: ContactCard): Content => {
  const input: Parameters<typeof asContact>[0] = { raw: card };
  input.name = waNameToSpectrum(card.name);
  if (card.phones.length > 0) {
    input.phones = card.phones.map(waPhoneToSpectrum);
  }
  if (card.emails.length > 0) {
    input.emails = card.emails.map(waEmailToSpectrum);
  }
  if (card.addresses.length > 0) {
    input.addresses = card.addresses.map(waAddressToSpectrum);
  }
  if (card.org) {
    input.org = waOrgToSpectrum(card.org);
  }
  if (card.urls.length > 0) {
    input.urls = card.urls.map((u: WaContactUrl) => u.url);
  }
  if (card.birthday) {
    input.birthday = card.birthday;
  }
  return asContact(input);
};

// Inbound group items are raw provider records that core's
// wrapProviderMessage inflates into full Messages. They must carry
// sender/space/timestamp — cloud webhook delivery serializes those per item
// and crashes on a missing sender.
const groupItem = (
  msg: InboundMessage,
  index: number,
  content: Content
): SpectrumMessage =>
  ({
    id: `${msg.id}:${index}`,
    content,
    sender: { id: msg.from },
    space: { id: msg.from },
    timestamp: msg.timestamp,
  }) as unknown as SpectrumMessage;

// Group items and multi-contact parts carry synthetic ids (`<wamid>:<index>`,
// cf. toMessages) that the Cloud API doesn't know. Strip the suffix so
// targeted actions (reply/react/read) hit the real parent message. Safe:
// wamids are `wamid.` + base64, which never contains ":".
const parentWamid = (id: string): string => id.split(":")[0] ?? id;

const toMessages = (
  client: WhatsAppClient,
  msg: InboundMessage
): WhatsAppMessage[] => {
  const base = {
    sender: { id: msg.from },
    space: { id: msg.from },
    timestamp: msg.timestamp,
  };
  if (msg.content.type === "contacts") {
    const multi = msg.content.contacts.length > 1;
    return msg.content.contacts.map((card, index) => ({
      ...base,
      id: multi ? `${msg.id}:${index}` : msg.id,
      content: withReplyContext(msg, waContactToSpectrum(card)),
    }));
  }
  return [
    {
      ...base,
      id: msg.id,
      content: withReplyContext(msg, mapContent(client, msg)),
    },
  ];
};

// Meta signals REMOVING a reaction as a reaction event whose emoji is the
// protobuf default "" which is not a valid `reaction` content (asReaction
// requires a non-empty emoji), and Meta doesn't say which emoji was removed
// (one reaction per user per message).
const mapReactionContent = (
  client: WhatsAppClient,
  msg: InboundMessage,
  reaction: { messageId: string; emoji: string }
): Content => {
  const reactedId = reaction.messageId;
  if (!reaction.emoji) {
    const cached = getCachedReaction(client, reactedId, msg.from);
    const removedReaction = cached
      ? {
          id: cached.id,
          content: asReaction({
            emoji: cached.emoji,
            target: reactionTargetStub(reactedId) as Parameters<
              typeof asReaction
            >[0]["target"],
          }),
        }
      : {
          id: `${reactedId}:reaction:${msg.from}`,
          content: asCustom({
            whatsapp_type: "reaction-removed",
            messageId: reactedId,
            stub: true,
          }),
        };
    return asUnsend({
      target: removedReaction as Parameters<typeof asUnsend>[0]["target"],
    });
  }
  // Remember the add so a later removal can report which emoji left.
  cacheReaction(client, reactedId, msg.from, {
    id: msg.id,
    emoji: reaction.emoji,
  });
  return asReaction({
    emoji: reaction.emoji,
    target: reactionTargetStub(reactedId) as Parameters<
      typeof asReaction
    >[0]["target"],
  });
};

const mapContent = (client: WhatsAppClient, msg: InboundMessage): Content => {
  const { content } = msg;
  switch (content.type) {
    case "text":
      return asText(content.body);
    case "image":
    case "video":
    case "audio":
    case "document": {
      const media =
        content.type === "audio" && content.media.voice
          ? lazyVoice(client, content.media)
          : lazyMedia(client, content.media);
      const caption = content.media.caption?.trim();
      if (!caption) {
        return media;
      }

      return asGroup({
        items: [groupItem(msg, 0, media), groupItem(msg, 1, asText(caption))],
      });
    }
    case "sticker":
      return asCustom({ whatsapp_type: "sticker", ...content.sticker });
    case "location":
      return asCustom({ whatsapp_type: "location", ...content.location });
    case "reaction":
      return mapReactionContent(client, msg, content.reaction);
    case "interactive": {
      const inter = content.interactive;
      if (inter.type === "button_reply" || inter.type === "list_reply") {
        const poll =
          msg.context?.id === undefined
            ? undefined
            : getPollCache(client).get(msg.context.id);
        const optionIndex = optionIndexFromId(inter.reply.id);
        const option =
          optionIndex === undefined ? undefined : poll?.options[optionIndex];
        if (poll && option) {
          return asPollOption({ poll, option, selected: true });
        }
      }
      return asCustom({ whatsapp_type: "interactive", ...inter });
    }
    case "button":
      return asCustom({ whatsapp_type: "button", ...content.button });
    case "order":
      return asCustom({ whatsapp_type: "order", ...content.order });
    case "system":
      return asCustom({ whatsapp_type: "system", ...content.system });
    default:
      return asCustom({ whatsapp_type: "unknown" });
  }
};

// WhatsApp media URLs are signed (the download credential lives in the query
// string), so drop the query from the recorded span URL — host + path are
// enough to identify the download. The real request still uses the full URL.
export const redactMediaUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
};

const waMediaFetch = tracedFetch("whatsapp-business", {
  redactUrl: redactMediaUrl,
});

const fetchMedia = async (
  client: WhatsAppClient,
  mediaId: string
): Promise<Response> => {
  const { url } = await client.media.getUrl(mediaId);
  const response = await waMediaFetch(url);
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`);
  }
  return response;
};

const lazyMediaSource = (
  client: WhatsAppClient,
  media: { id: string; mimeType: string; filename?: string }
) => ({
  id: media.id,
  name: media.filename ?? `media-${media.id}`,
  mimeType: media.mimeType,
  read: async () =>
    Buffer.from(await (await fetchMedia(client, media.id)).arrayBuffer()),
  stream: async () => {
    const response = await fetchMedia(client, media.id);
    if (!response.body) {
      throw new Error("Media response missing body");
    }
    return response.body;
  },
});

const lazyMedia = (
  client: WhatsAppClient,
  media: { id: string; mimeType: string; filename?: string }
): Content => asAttachment(lazyMediaSource(client, media));

// WhatsApp flags push-to-talk recordings with media.voice — surface them as
// voice content so apps can tell a voice note from an audio file attachment.
const lazyVoice = (
  client: WhatsAppClient,
  media: { id: string; mimeType: string; filename?: string }
): Content => asVoice(lazyMediaSource(client, media));

const mimeToMediaType = (
  mimeType: string
): "image" | "video" | "audio" | "document" => {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "document";
};

const voiceFilename = (content: ContentOfType<"voice">): string => {
  if (content.name) {
    return content.name;
  }
  const ext = mimeExtension(content.mimeType);
  return ext ? `voice.${ext}` : "voice";
};

const spectrumPhoneTypeToWa = (
  type: SpectrumContactPhone["type"]
): string | undefined => {
  if (type === "mobile") {
    return "CELL";
  }
  if (type === "home" || type === "work" || type === "other") {
    return type.toUpperCase();
  }
  return;
};

const spectrumSimpleTypeToWa = (
  type: "home" | "work" | "other" | undefined
): string | undefined => (type ? type.toUpperCase() : undefined);

const spectrumNameToWa = (name: Contact["name"]): WaContactName => ({
  formattedName:
    name?.formatted ??
    ([name?.first, name?.middle, name?.last]
      .filter((p): p is string => Boolean(p))
      .join(" ") ||
      "Unknown"),
  firstName: name?.first,
  lastName: name?.last,
  middleName: name?.middle,
  prefix: name?.prefix,
  suffix: name?.suffix,
});

const isWhatsAppContactCard = (value: unknown): value is ContactCardInput => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const raw = value as Record<string, unknown>;
  const name = raw.name as Record<string, unknown> | undefined;
  if (
    !name ||
    typeof name !== "object" ||
    typeof name.formattedName !== "string"
  ) {
    return false;
  }
  return (
    Array.isArray(raw.phones) &&
    Array.isArray(raw.emails) &&
    Array.isArray(raw.addresses) &&
    Array.isArray(raw.urls)
  );
};

const contactToWa = (contact: Contact): ContactCardInput => {
  if (isWhatsAppContactCard(contact.raw)) {
    return contact.raw;
  }
  const card: ContactCardInput = {
    name: spectrumNameToWa(contact.name),
    phones: (contact.phones ?? []).map((p) => ({
      phone: p.value,
      type: spectrumPhoneTypeToWa(p.type),
    })),
    emails: (contact.emails ?? []).map((e) => ({
      email: e.value,
      type: spectrumSimpleTypeToWa(e.type),
    })),
    addresses: (contact.addresses ?? []).map((a) => ({
      street: a.street,
      city: a.city,
      state: a.region,
      zip: a.postalCode,
      country: a.country,
      type: spectrumSimpleTypeToWa(a.type),
    })),
    urls: (contact.urls ?? []).map((url) => ({ url })),
    org:
      contact.org?.name || contact.org?.department || contact.org?.title
        ? {
            company: contact.org.name,
            department: contact.org.department,
            title: contact.org.title,
          }
        : undefined,
    birthday: contact.birthday,
  };
  return card;
};

const streamLog = createLogger("spectrum.whatsapp.stream");

const clientStream = (
  client: WhatsAppClient
): ManagedStream<WhatsAppMessage> => {
  const eventStream = client.events
    .subscribe({
      // The client heals disconnects AND silently stalled streams on its own
      // (its stallTimeoutMs converts missed heartbeats into a reconnect with
      // cursor gap-fill). That recovery is invisible from out here, so
      // surface each attempt for operators — without this a stalled stream
      // heals with zero log evidence and a flapping upstream is
      // indistinguishable from a healthy one.
      reconnect: {
        onReconnect: (attempt) => {
          streamLog.warn("whatsapp live stream reconnecting", {
            "spectrum.whatsapp.reconnect_attempt": attempt,
          });
        },
      },
    })
    .filter(
      (e): e is Extract<typeof e, { type: "message" }> => e.type === "message"
    );

  return stream<WhatsAppMessage>((emit, end) => {
    const pump = (async () => {
      try {
        for await (const event of eventStream) {
          // One unmappable event must not kill the live stream: a mapping
          // throw here ends the merged stream for the whole project, and
          // nothing downstream restarts it. Skip the event and keep pumping.
          let mapped: WhatsAppMessage[];
          try {
            mapped = toMessages(client, event.message);
          } catch (error) {
            streamLog.warn(
              "skipping unmappable whatsapp message event",
              {
                "spectrum.whatsapp.message_id": event.message.id,
                ...errorAttrs(error),
              },
              error instanceof Error ? error : undefined
            );
            continue;
          }
          for (const m of mapped) {
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
  clients: WhatsAppClients
): ManagedStream<WhatsAppMessage> => mergeStreams(clients.map(clientStream));

// Meta caps media captions at 1024 characters (image/video/document docs).
const MAX_CAPTION_LENGTH = 1024;

// Meta accepts captions only on image/video/document sends.
const captionablePair = (
  group: Group
): { attachment: ContentOfType<"attachment">; caption: string } | undefined => {
  if (group.items.length !== 2) {
    return;
  }
  const contents = group.items.map((item) => item.content as Content);
  const attachment = contents.find(
    (c): c is ContentOfType<"attachment"> => c.type === "attachment"
  );
  const text = contents.find(
    (c): c is ContentOfType<"text"> => c.type === "text"
  );
  const captionable =
    attachment &&
    text &&
    mimeToMediaType(attachment.mimeType) !== "audio" &&
    text.text.length <= MAX_CAPTION_LENGTH;
  return captionable ? { attachment, caption: text.text } : undefined;
};

// A captionable [attachment, text] pair collapses to one captioned media
// send — the shape our own inbound mapping produces for captioned media.
// Every other composition falls back to sending each item as its own message
// so no part of the group is silently dropped.
const sendGroupParts = async (
  clients: WhatsAppClients,
  spaceId: string,
  group: Group,
  replyTo?: string
): Promise<ProviderMessageRecord> => {
  const pair = captionablePair(group);
  if (pair) {
    const client = primary(clients);
    const { attachment, caption } = pair;
    const { mediaId } = await client.media.upload({
      file: await attachment.read(),
      mimeType: attachment.mimeType,
      filename: attachment.name,
    });
    const mediaType = mimeToMediaType(attachment.mimeType);
    const mediaPayload =
      mediaType === "document"
        ? { id: mediaId, filename: attachment.name, caption }
        : { id: mediaId, caption };
    // send as a caption-text pair together, goes out as 1 obj.
    return toRecord(
      await client.messages.send({
        to: spaceId,
        ...(replyTo === undefined ? {} : { replyTo }),
        [mediaType]: mediaPayload,
      } as Parameters<typeof client.messages.send>[0]),
      spaceId,
      group
    );
  }
  const sent: ProviderMessageRecord[] = [];
  let first: ProviderMessageRecord | undefined;
  for (const [index, item] of group.items.entries()) {
    const itemContent = item.content as Content;
    let record: ProviderMessageRecord | undefined;
    try {
      // Only the first part quotes the reply target — one bubble carrying
      // the context reads better than every part quoting the same message.
      record =
        index === 0 && replyTo !== undefined
          ? await replyToMessage(clients, spaceId, replyTo, itemContent)
          : await send(clients, spaceId, itemContent);
    } catch (error) {
      if (sent.length === 0) {
        // Nothing delivered yet thus we surface the original error untouched so
        // core's UnsupportedError fallbacks (markdown/streamText downgrade,
        // warn-and-skip) keep working.
        throw error;
      }
      throw new WhatsAppPartialSendError({
        sent,
        failedIndex: index,
        total: group.items.length,
        cause: error,
      });
    }
    if (record) {
      sent.push(record);
    }
    first ??= record;
  }
  if (!first) {
    throw UnsupportedError.content(group.type);
  }
  return { ...first, content: group };
};

// Flat languageCode and an (empty-ok) components array — the exact shapes the
// SDK proto knows; the relay renames them to Meta's `language.code` /
// `components` wire fields. Body params serialize as { type: "text", text }
// parameter objects per Meta's template-messages docs.
const toTemplateInput = (content: WhatsAppTemplate): TemplateInput => ({
  name: content.name,
  languageCode: content.languageCode,
  components: content.bodyParams?.length
    ? [
        {
          type: "body",
          parameters: content.bodyParams.map((text) => ({
            type: "text",
            text,
          })),
        },
      ]
    : [],
});

export const send = async (
  clients: WhatsAppClients,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord | undefined> => {
  if (isWhatsAppTemplate(content)) {
    return toRecord(
      await primary(clients).messages.send({
        to: spaceId,
        template: toTemplateInput(content),
      }),
      spaceId,
      content as unknown as Content
    );
  }
  if (content.type === "reply") {
    return await replyToMessage(
      clients,
      spaceId,
      parentWamid(content.target.id),
      content.content
    );
  }
  if (content.type === "reaction") {
    return await reactToMessage(clients, spaceId, content);
  }
  if (content.type === "typing") {
    // WhatsApp Business has no typing-indicator API. Silently ignore so
    // `space.startTyping()` / `space.responding()` work portably across
    // platforms — typing is a hint, not a critical message.
    return;
  }
  if (content.type === "read") {
    // Cumulative receipt: the Cloud API marks `target` and every earlier
    // message in the conversation as read (blue ticks for the sender).
    await primary(clients).messages.markRead(parentWamid(content.target.id));
    return;
  }
  if (content.type === "unsend") {
    // The Cloud API can only retract reactions — resend the reaction with
    // emoji: "" at the reacted message. Regular business messages cannot be
    // deleted, so any other target stays unsupported.
    const unsent = content.target.content;
    if (unsent.type !== "reaction") {
      throw UnsupportedError.content(content.type);
    }
    await primary(clients).messages.send({
      to: spaceId,
      reaction: {
        messageId: parentWamid(unsent.target.id),
        emoji: "",
      },
    });
    return;
  }
  const client = primary(clients);
  switch (content.type) {
    case "text":
      return toRecord(
        await client.messages.send({ to: spaceId, text: content.text }),
        spaceId,
        content
      );
    case "attachment": {
      const { mediaId } = await client.media.upload({
        file: await content.read(),
        mimeType: content.mimeType,
        filename: content.name,
      });
      const mediaType = mimeToMediaType(content.mimeType);
      const mediaPayload =
        mediaType === "document"
          ? { id: mediaId, filename: content.name }
          : { id: mediaId };
      return toRecord(
        await client.messages.send({
          to: spaceId,
          [mediaType]: mediaPayload,
        } as Parameters<typeof client.messages.send>[0]),
        spaceId,
        content
      );
    }
    case "contact":
      return toRecord(
        await client.messages.send({
          to: spaceId,
          contacts: [contactToWa(content)],
        }),
        spaceId,
        content
      );
    case "voice": {
      const { mediaId } = await client.media.upload({
        file: await content.read(),
        mimeType: content.mimeType,
        filename: voiceFilename(content),
      });
      return toRecord(
        await client.messages.send({
          to: spaceId,
          audio: { id: mediaId },
        } as Parameters<typeof client.messages.send>[0]),
        spaceId,
        content
      );
    }
    case "poll": {
      const result = await client.messages.send({
        to: spaceId,
        interactive: pollToInteractive(content),
      });
      cachePoll(client, result.messageId, content);
      return toRecord(result, spaceId, content);
    }
    case "richlink":
      // WhatsApp renders link previews client-side from the URL's own OG
      // metadata; previewUrl opts in (falls back to a plain link on failure).
      return toRecord(
        await client.messages.send({
          to: spaceId,
          text: { body: content.url, previewUrl: true },
        }),
        spaceId,
        content
      );
    case "app":
      // No mini-app surface on WhatsApp — send the URL with a link preview.
      return toRecord(
        await client.messages.send({
          to: spaceId,
          text: { body: await content.url(), previewUrl: true },
        }),
        spaceId,
        content
      );
    case "group":
      return await sendGroupParts(clients, spaceId, content);
    default:
      throw UnsupportedError.content(content.type);
  }
};

const reactToMessage = async (
  clients: WhatsAppClients,
  spaceId: string,
  content: Reaction
): Promise<ProviderMessageRecord> => {
  // The Cloud API returns a real message id for reaction sends, so the
  // record carries a genuine handle (usable by a future unsend).
  const result = await primary(clients).messages.send({
    to: spaceId,
    reaction: {
      messageId: parentWamid(content.target.id),
      emoji: content.emoji,
    },
  });
  return toRecord(result, spaceId, content);
};

export const replyToMessage = async (
  clients: WhatsAppClients,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const client = primary(clients);
  if (isWhatsAppTemplate(content)) {
    return toRecord(
      await client.messages.send({
        to: spaceId,
        replyTo: messageId,
        template: toTemplateInput(content),
      }),
      spaceId,
      content as unknown as Content
    );
  }
  switch (content.type) {
    case "text":
      return toRecord(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          text: content.text,
        }),
        spaceId,
        content
      );
    case "attachment": {
      const { mediaId } = await client.media.upload({
        file: await content.read(),
        mimeType: content.mimeType,
        filename: content.name,
      });
      const mediaType = mimeToMediaType(content.mimeType);
      const mediaPayload =
        mediaType === "document"
          ? { id: mediaId, filename: content.name }
          : { id: mediaId };
      return toRecord(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          [mediaType]: mediaPayload,
        } as Parameters<typeof client.messages.send>[0]),
        spaceId,
        content
      );
    }
    case "contact":
      return toRecord(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          contacts: [contactToWa(content)],
        }),
        spaceId,
        content
      );
    case "voice": {
      const { mediaId } = await client.media.upload({
        file: await content.read(),
        mimeType: content.mimeType,
        filename: voiceFilename(content),
      });
      return toRecord(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          audio: { id: mediaId },
        } as Parameters<typeof client.messages.send>[0]),
        spaceId,
        content
      );
    }
    case "poll": {
      const result = await client.messages.send({
        to: spaceId,
        replyTo: messageId,
        interactive: pollToInteractive(content),
      });
      cachePoll(client, result.messageId, content);
      return toRecord(result, spaceId, content);
    }
    case "richlink":
      // WhatsApp renders link previews client-side from the URL's own OG
      // metadata; previewUrl opts in (falls back to a plain link on failure).
      return toRecord(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          text: { body: content.url, previewUrl: true },
        }),
        spaceId,
        content
      );
    case "app":
      // No mini-app surface on WhatsApp — send the URL with a link preview.
      return toRecord(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          text: { body: await content.url(), previewUrl: true },
        }),
        spaceId,
        content
      );
    case "group":
      return await sendGroupParts(clients, spaceId, content, messageId);
    default:
      throw UnsupportedError.content(content.type);
  }
};
