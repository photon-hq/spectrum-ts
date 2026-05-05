import type {
  ContactCard,
  InboundInteractive,
  InboundMedia,
  InboundMessage,
  InboundSticker,
  Location,
} from "@photon-ai/whatsapp-business";
import type { SpectrumLike } from "../../platform/types";
import type { Store } from "../../utils/store";
import {
  createWebhookStateSlot,
  handleMetaChallenge,
  type InboundQueue,
  META_HUB_SIGNATURE_HEADER,
  makeInboundQueue,
  verifyMetaSignature,
} from "../../utils/webhook";
import type { WebhookIngressConfig } from "./types";

const PLATFORM_NAME = "WhatsApp Business";
const META_OBJECT = "whatsapp_business_account";

/**
 * Per-platform-instance webhook state. Stored on the platform's `Store`
 * via the slot helper so both `events.messages` (called inside Spectrum)
 * and `whatsappBusiness.webhook(app)` (called by user code) can reach the
 * same queue. Initialized eagerly in `lifecycle.createClient` so a webhook
 * that arrives before the agent's `for-await` loop starts is buffered,
 * not lost.
 */
interface WebhookState {
  appSecret: string;
  inbound: InboundQueue<InboundMessage>;
  verifyToken: string;
}

const slot = createWebhookStateSlot<WebhookState>({
  platformName: PLATFORM_NAME,
  storeKey: "spectrum-ts:whatsapp-business:webhook",
  notConfiguredMessage:
    `Platform "${PLATFORM_NAME}" is not configured for webhook ingress. ` +
    "Set `ingress: { mode: 'webhook', verifyToken }` on whatsappBusiness.config().",
  isState: (value): value is WebhookState =>
    typeof value === "object" &&
    value !== null &&
    "appSecret" in value &&
    "verifyToken" in value &&
    "inbound" in value,
});

export const initWebhookState = (
  store: Store,
  config: WebhookIngressConfig,
  appSecret: string
): void => {
  slot.init(store, {
    appSecret,
    verifyToken: config.verifyToken,
    inbound: makeInboundQueue<InboundMessage>(),
  });
};

export const getWebhookInbound = (
  store: Store
): AsyncIterable<InboundMessage> & { close: () => void } => {
  const state = slot.read(store);
  return Object.assign(state.inbound.iterable, {
    close: () => state.inbound.close(),
  });
};

export interface WebhookHandle {
  handle(request: Request): Promise<Response>;
}

/**
 * Returns a Web-Fetch-shaped handler the customer mounts in any HTTP
 * framework (Hono, Bun.serve, Cloudflare Workers, Next.js Route Handlers,
 * etc).
 *
 * - `GET` requests answer Meta's verification challenge.
 * - `POST` requests verify the HMAC against the raw body, parse the Meta
 *   webhook envelope, and enqueue each inbound message for the agent loop.
 */
export const webhook = (spectrum: SpectrumLike): WebhookHandle => {
  const state = slot.readFromSpectrum(spectrum);
  return {
    async handle(request: Request): Promise<Response> {
      if (request.method === "GET") {
        return handleMetaChallenge(request, state.verifyToken);
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const rawBody = Buffer.from(await request.arrayBuffer());
      const signature = request.headers.get(META_HUB_SIGNATURE_HEADER);
      if (!verifyMetaSignature(rawBody, signature, state.appSecret)) {
        return new Response("Forbidden", { status: 403 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      for (const message of parseMetaPayload(parsed)) {
        state.inbound.push(message);
      }
      return new Response("", { status: 200 });
    },
  };
};

// ---------------------------------------------------------------------------
// Meta webhook payload parser
//
// Reference shape:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
//
// Maps Meta's JSON envelope into the same `InboundMessage` shape that
// `@photon-ai/whatsapp-business`'s `events.subscribe()` produces, so the
// downstream pipeline (toMessages / mapContent in messages.ts) is reused
// unchanged.
// ---------------------------------------------------------------------------

interface MetaEnvelope {
  entry?: MetaEntry[];
  object?: string;
}

interface MetaEntry {
  changes?: MetaChange[];
}

interface MetaChange {
  field?: string;
  value?: MetaChangeValue;
}

interface MetaChangeValue {
  messages?: MetaMessage[];
}

interface MetaMessage {
  audio?: MetaMedia & { voice?: boolean };
  button?: { payload?: string; text?: string };
  contacts?: MetaContactCard[];
  context?: MetaContext;
  document?: MetaMedia;
  errors?: MetaApiError[];
  from: string;
  id: string;
  image?: MetaMedia;
  interactive?: MetaInteractive;
  location?: MetaLocation;
  order?: MetaOrder;
  reaction?: { emoji?: string; message_id?: string };
  referral?: MetaReferral;
  sticker?: MetaSticker;
  system?: MetaSystem;
  text?: { body?: string };
  timestamp: string;
  type: string;
  video?: MetaMedia;
}

interface MetaMedia {
  caption?: string;
  filename?: string;
  id?: string;
  mime_type?: string;
  sha256?: string;
}

interface MetaSticker {
  animated?: boolean;
  id?: string;
  mime_type?: string;
  sha256?: string;
}

interface MetaLocation {
  address?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
}

interface MetaContactCard {
  addresses?: MetaContactAddress[];
  birthday?: string;
  emails?: MetaContactEmail[];
  name?: MetaContactName;
  org?: MetaContactOrg;
  phones?: MetaContactPhone[];
  urls?: MetaContactUrl[];
}

interface MetaContactName {
  first_name?: string;
  formatted_name?: string;
  last_name?: string;
  middle_name?: string;
  prefix?: string;
  suffix?: string;
}

interface MetaContactPhone {
  phone?: string;
  type?: string;
  wa_id?: string;
}

interface MetaContactEmail {
  email?: string;
  type?: string;
}

interface MetaContactAddress {
  city?: string;
  country?: string;
  country_code?: string;
  state?: string;
  street?: string;
  type?: string;
  zip?: string;
}

interface MetaContactOrg {
  company?: string;
  department?: string;
  title?: string;
}

interface MetaContactUrl {
  type?: string;
  url?: string;
}

interface MetaContext {
  forwarded?: boolean;
  frequently_forwarded?: boolean;
  from?: string;
  id?: string;
}

interface MetaInteractive {
  button_reply?: { id?: string; title?: string };
  list_reply?: { description?: string; id?: string; title?: string };
  nfm_reply?: { body?: string; name?: string; response_json?: string };
  type?: string;
}

interface MetaOrder {
  catalog_id?: string;
  product_items?: Array<{
    currency?: string;
    item_price?: number;
    product_retailer_id?: string;
    quantity?: number;
  }>;
  text?: string;
}

interface MetaSystem {
  body?: string;
  new_wa_id?: string;
  type?: string;
  wa_id?: string;
}

interface MetaReferral {
  body?: string;
  headline?: string;
  source_id?: string;
  source_type?: string;
  source_url?: string;
}

interface MetaApiError {
  code?: number;
  details?: string;
  href?: string;
  message?: string;
  title?: string;
}

const isMetaEnvelope = (value: unknown): value is MetaEnvelope =>
  typeof value === "object" &&
  value !== null &&
  (value as { object?: unknown }).object === META_OBJECT;

const parseTimestamp = (raw: string | undefined): Date => {
  if (!raw) {
    return new Date();
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    return new Date();
  }
  return new Date(seconds * 1000);
};

const parseErrors = (
  errors: MetaApiError[] | undefined
): InboundMessage["errors"] => {
  if (!errors) {
    return [];
  }
  return errors.map((e) => ({
    code: e.code ?? 0,
    title: e.title ?? "",
    details: e.details,
    href: e.href,
    message: e.message,
  }));
};

const parseMedia = (m: MetaMedia | undefined): InboundMedia | undefined => {
  if (!(m?.id && m.mime_type)) {
    return;
  }
  return {
    id: m.id,
    mimeType: m.mime_type,
    caption: m.caption,
    filename: m.filename,
    sha256: m.sha256,
  };
};

const parseAudio = (
  m: (MetaMedia & { voice?: boolean }) | undefined
): InboundMedia | undefined => {
  if (!(m?.id && m.mime_type)) {
    return;
  }
  return {
    id: m.id,
    mimeType: m.mime_type,
    caption: m.caption,
    filename: m.filename,
    sha256: m.sha256,
    voice: m.voice,
  };
};

const parseSticker = (
  s: MetaSticker | undefined
): InboundSticker | undefined => {
  if (!(s?.id && s.mime_type)) {
    return;
  }
  return {
    id: s.id,
    mimeType: s.mime_type,
    animated: s.animated,
    sha256: s.sha256,
  };
};

const parseLocation = (l: MetaLocation | undefined): Location | undefined => {
  if (l?.latitude === undefined || l?.longitude === undefined) {
    return;
  }
  return {
    latitude: l.latitude,
    longitude: l.longitude,
    address: l.address,
    name: l.name,
  };
};

const parseContacts = (
  raw: MetaContactCard[] | undefined
): readonly ContactCard[] => {
  if (!raw || raw.length === 0) {
    return [];
  }
  return raw.map((card) => ({
    addresses: (card.addresses ?? []).map((a) => ({
      city: a.city,
      country: a.country,
      countryCode: a.country_code,
      state: a.state,
      street: a.street,
      type: a.type,
      zip: a.zip,
    })),
    birthday: card.birthday,
    emails: (card.emails ?? []).map((e) => ({
      email: e.email ?? "",
      type: e.type,
    })),
    name: {
      formattedName: card.name?.formatted_name ?? "",
      firstName: card.name?.first_name,
      lastName: card.name?.last_name,
      middleName: card.name?.middle_name,
      prefix: card.name?.prefix,
      suffix: card.name?.suffix,
    },
    org: card.org && {
      company: card.org.company,
      department: card.org.department,
      title: card.org.title,
    },
    phones: (card.phones ?? []).map((p) => ({
      phone: p.phone ?? "",
      type: p.type,
      waId: p.wa_id,
    })),
    urls: (card.urls ?? []).map((u) => ({
      type: u.type,
      url: u.url ?? "",
    })),
  }));
};

const parseInteractive = (
  i: MetaInteractive | undefined
): InboundInteractive | undefined => {
  if (!i) {
    return;
  }
  if (i.button_reply) {
    return {
      type: "button_reply",
      reply: {
        id: i.button_reply.id ?? "",
        title: i.button_reply.title ?? "",
      },
    };
  }
  if (i.list_reply) {
    return {
      type: "list_reply",
      reply: {
        id: i.list_reply.id ?? "",
        title: i.list_reply.title ?? "",
        description: i.list_reply.description,
      },
    };
  }
  if (i.nfm_reply) {
    return {
      type: "nfm_reply",
      reply: {
        body: i.nfm_reply.body,
        name: i.nfm_reply.name,
        responseJson: i.nfm_reply.response_json ?? "",
      },
    };
  }
  return;
};

// ---------------------------------------------------------------------------
// Per-content-type parsers — split into a dispatch table so `parseContent`
// stays trivial. Adding a new content type is one new function plus one
// new entry below.
// ---------------------------------------------------------------------------

type ContentParser = (msg: MetaMessage) => InboundMessage["content"];

const parseTextContent: ContentParser = (msg) => ({
  type: "text",
  body: msg.text?.body ?? "",
});

const parseImageContent: ContentParser = (msg) => {
  const media = parseMedia(msg.image);
  return media ? { type: "image", media } : { type: "unknown" };
};

const parseVideoContent: ContentParser = (msg) => {
  const media = parseMedia(msg.video);
  return media ? { type: "video", media } : { type: "unknown" };
};

const parseAudioContent: ContentParser = (msg) => {
  const media = parseAudio(msg.audio);
  return media ? { type: "audio", media } : { type: "unknown" };
};

const parseDocumentContent: ContentParser = (msg) => {
  const media = parseMedia(msg.document);
  return media ? { type: "document", media } : { type: "unknown" };
};

const parseStickerContent: ContentParser = (msg) => {
  const sticker = parseSticker(msg.sticker);
  return sticker ? { type: "sticker", sticker } : { type: "unknown" };
};

const parseLocationContent: ContentParser = (msg) => {
  const location = parseLocation(msg.location);
  return location ? { type: "location", location } : { type: "unknown" };
};

const parseContactsContent: ContentParser = (msg) => {
  const contacts = parseContacts(msg.contacts);
  return contacts.length > 0
    ? { type: "contacts", contacts }
    : { type: "unknown" };
};

const parseReactionContent: ContentParser = (msg) => {
  if (!(msg.reaction?.message_id && msg.reaction.emoji)) {
    return { type: "unknown" };
  }
  return {
    type: "reaction",
    reaction: {
      emoji: msg.reaction.emoji,
      messageId: msg.reaction.message_id,
    },
  };
};

const parseInteractiveContent: ContentParser = (msg) => {
  const interactive = parseInteractive(msg.interactive);
  return interactive
    ? { type: "interactive", interactive }
    : { type: "unknown" };
};

const parseButtonContent: ContentParser = (msg) => ({
  type: "button",
  button: {
    payload: msg.button?.payload ?? "",
    text: msg.button?.text ?? "",
  },
});

const parseOrderContent: ContentParser = (msg) => ({
  type: "order",
  order: {
    catalogId: msg.order?.catalog_id ?? "",
    productItems: (msg.order?.product_items ?? []).map((item) => ({
      currency: item.currency ?? "",
      itemPrice: item.item_price ?? 0,
      productRetailerId: item.product_retailer_id ?? "",
      quantity: item.quantity ?? 0,
    })),
    text: msg.order?.text,
  },
});

const parseSystemContent: ContentParser = (msg) => ({
  type: "system",
  system: {
    body: msg.system?.body ?? "",
    type: msg.system?.type ?? "",
    newWaId: msg.system?.new_wa_id,
    waId: msg.system?.wa_id,
  },
});

const CONTENT_PARSERS: Record<string, ContentParser> = {
  text: parseTextContent,
  image: parseImageContent,
  video: parseVideoContent,
  audio: parseAudioContent,
  document: parseDocumentContent,
  sticker: parseStickerContent,
  location: parseLocationContent,
  contacts: parseContactsContent,
  reaction: parseReactionContent,
  interactive: parseInteractiveContent,
  button: parseButtonContent,
  order: parseOrderContent,
  system: parseSystemContent,
};

const parseContent = (msg: MetaMessage): InboundMessage["content"] => {
  const parser = CONTENT_PARSERS[msg.type];
  return parser ? parser(msg) : { type: "unknown" };
};

const buildInboundMessage = (msg: MetaMessage): InboundMessage => ({
  id: msg.id,
  from: msg.from,
  timestamp: parseTimestamp(msg.timestamp),
  messageType: msg.type,
  content: parseContent(msg),
  context: msg.context && {
    forwarded: msg.context.forwarded,
    frequentlyForwarded: msg.context.frequently_forwarded,
    from: msg.context.from,
    id: msg.context.id,
  },
  errors: parseErrors(msg.errors),
  referral: msg.referral && {
    sourceType: msg.referral.source_type ?? "",
    sourceUrl: msg.referral.source_url ?? "",
    sourceId: msg.referral.source_id,
    headline: msg.referral.headline,
    body: msg.referral.body,
  },
});

export const parseMetaPayload = (payload: unknown): InboundMessage[] => {
  if (!isMetaEnvelope(payload)) {
    return [];
  }
  const result: InboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") {
        continue;
      }
      for (const message of change.value?.messages ?? []) {
        if (!(message.id && message.from)) {
          continue;
        }
        result.push(buildInboundMessage(message));
      }
    }
  }
  return result;
};
