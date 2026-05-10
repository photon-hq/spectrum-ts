import type {
  ContactCard,
  ContactCardInput,
  InboundMessage,
  WhatsAppClient,
} from "@photon-ai/whatsapp-business";
import { extension as mimeExtension } from "mime-types";
import { asAttachment } from "../../content/attachment";
import {
  asContact,
  type Contact,
  type ContactAddress as SpectrumContactAddress,
  type ContactEmail as SpectrumContactEmail,
  type ContactName as SpectrumContactName,
  type ContactOrg as SpectrumContactOrg,
  type ContactPhone as SpectrumContactPhone,
} from "../../content/contact";
import { asCustom } from "../../content/custom";
import { asPollOption, type Poll } from "../../content/poll";
import { asReaction } from "../../content/reaction";
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import type { ProviderMessageRecord } from "../../platform/types";
import { UnsupportedError } from "../../utils/errors";
import { type ManagedStream, mergeStreams, stream } from "../../utils/stream";
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
      content: waContactToSpectrum(card),
    }));
  }
  return [
    {
      ...base,
      id: msg.id,
      content: mapContent(client, msg),
    },
  ];
};

const mapContent = (client: WhatsAppClient, msg: InboundMessage): Content => {
  const { content } = msg;
  switch (content.type) {
    case "text":
      return asText(content.body);
    case "image":
    case "video":
    case "audio":
    case "document":
      return lazyMedia(client, content.media);
    case "sticker":
      return asCustom({ whatsapp_type: "sticker", ...content.sticker });
    case "location":
      return asCustom({ whatsapp_type: "location", ...content.location });
    case "reaction": {
      // WhatsApp reaction events carry only the target message id; synthesize
      // a minimal target Message shape. Core's wrapProviderMessage inflates
      // this into a full Message with react/reply methods at emit time.
      const stubTarget = {
        id: content.reaction.messageId,
        content: asCustom({ whatsapp_type: "reaction-target", stub: true }),
      };
      return asReaction({
        emoji: content.reaction.emoji,
        target: stubTarget as Parameters<typeof asReaction>[0]["target"],
      });
    }
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

const fetchMedia = async (
  client: WhatsAppClient,
  mediaId: string
): Promise<Response> => {
  const { url } = await client.media.getUrl(mediaId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`);
  }
  return response;
};

const lazyMedia = (
  client: WhatsAppClient,
  media: { id: string; mimeType: string; filename?: string }
): Content =>
  asAttachment({
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

const voiceFilename = (
  content: Extract<Content, { type: "voice" }>
): string => {
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

const clientStream = (
  client: WhatsAppClient
): ManagedStream<WhatsAppMessage> => {
  const eventStream = client.events
    .subscribe()
    .filter(
      (e): e is Extract<typeof e, { type: "message" }> => e.type === "message"
    );

  return stream<WhatsAppMessage>((emit, end) => {
    const pump = (async () => {
      try {
        for await (const event of eventStream) {
          for (const m of toMessages(client, event.message)) {
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

export const send = async (
  clients: WhatsAppClients,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
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
    default:
      throw UnsupportedError.content(content.type);
  }
};

export const reactToMessage = async (
  clients: WhatsAppClients,
  spaceId: string,
  messageId: string,
  reaction: string
): Promise<void> => {
  await primary(clients).messages.send({
    to: spaceId,
    reaction: { messageId, emoji: reaction },
  });
};

export const replyToMessage = async (
  clients: WhatsAppClients,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  const client = primary(clients);
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
    default:
      throw UnsupportedError.content(content.type);
  }
};
