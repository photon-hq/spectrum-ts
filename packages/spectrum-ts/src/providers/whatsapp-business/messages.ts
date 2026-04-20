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
import { asText } from "../../content/text";
import type { Content } from "../../content/types";
import type { SendResult } from "../../platform/types";
import { type ManagedStream, stream } from "../../utils/stream";
import type { WhatsAppMessage } from "./types";

type WaSendResult = Awaited<ReturnType<WhatsAppClient["messages"]["send"]>>;

const toSendResult = (result: WaSendResult): SendResult => ({
  id: result.messageId,
});

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
    return undefined;
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
    return undefined;
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
      content: mapContent(client, msg.content),
    },
  ];
};

const mapContent = (
  client: WhatsAppClient,
  content: InboundMessage["content"]
): Content => {
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
    case "reaction":
      return asCustom({ whatsapp_type: "reaction", ...content.reaction });
    case "interactive":
      return asCustom({ whatsapp_type: "interactive", ...content.interactive });
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
  return undefined;
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

export const messages = (
  client: WhatsAppClient
): ManagedStream<WhatsAppMessage> => {
  const eventStream = client.events
    .subscribe()
    .filter(
      (e): e is Extract<typeof e, { type: "message" }> => e.type === "message"
    );

  return stream<WhatsAppMessage>((emit, end) => {
    (async () => {
      try {
        for await (const event of eventStream) {
          for (const m of toMessages(client, event.message)) {
            emit(m);
          }
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return () => eventStream.close();
  });
};

export const send = async (
  client: WhatsAppClient,
  spaceId: string,
  content: Content
): Promise<SendResult> => {
  switch (content.type) {
    case "text":
      return toSendResult(
        await client.messages.send({ to: spaceId, text: content.text })
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
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          [mediaType]: mediaPayload,
        } as Parameters<typeof client.messages.send>[0])
      );
    }
    case "contact":
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          contacts: [contactToWa(content)],
        })
      );
    case "voice": {
      const { mediaId } = await client.media.upload({
        file: await content.read(),
        mimeType: content.mimeType,
        filename: voiceFilename(content),
      });
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          audio: { id: mediaId },
        } as Parameters<typeof client.messages.send>[0])
      );
    }
    default:
      throw new Error(`Unsupported WhatsApp content type: ${content.type}`);
  }
};

export const reactToMessage = async (
  client: WhatsAppClient,
  spaceId: string,
  messageId: string,
  reaction: string
): Promise<void> => {
  await client.messages.send({
    to: spaceId,
    reaction: { messageId, emoji: reaction },
  });
};

export const replyToMessage = async (
  client: WhatsAppClient,
  spaceId: string,
  messageId: string,
  content: Content
): Promise<SendResult> => {
  switch (content.type) {
    case "text":
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          text: content.text,
        })
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
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          [mediaType]: mediaPayload,
        } as Parameters<typeof client.messages.send>[0])
      );
    }
    case "contact":
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          contacts: [contactToWa(content)],
        })
      );
    case "voice": {
      const { mediaId } = await client.media.upload({
        file: await content.read(),
        mimeType: content.mimeType,
        filename: voiceFilename(content),
      });
      return toSendResult(
        await client.messages.send({
          to: spaceId,
          replyTo: messageId,
          audio: { id: mediaId },
        } as Parameters<typeof client.messages.send>[0])
      );
    }
    default:
      throw new Error(`Unsupported WhatsApp content type: ${content.type}`);
  }
};
