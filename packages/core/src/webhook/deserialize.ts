import { asAttachment } from "../content/attachment";
import {
  asContact,
  type ContactInput,
  type ContactPhone,
} from "../content/contact";
import { asCustom } from "../content/custom";
import type { Content } from "../content/types";
import type { ProviderMessageRecord } from "../platform/build";
import { UnsupportedError } from "../utils/errors";
import type {
  SlimContent,
  SlimEnvelope,
  SlimMessage,
  SlimMessageRef,
} from "./types";

/** The single event type that carries a message today. */
const MESSAGES_EVENT = "messages";
const DEFAULT_ATTACHMENT_NAME = "attachment";
const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Lazy byte accessors for an attachment whose bytes are fetched on demand —
 * the native webhook delivers attachment metadata only.
 */
export interface AttachmentBytes {
  read: () => Promise<Buffer>;
  stream?: () => Promise<ReadableStream<Uint8Array>>;
}

export interface DeserializeContext {
  /**
   * Reconstruct lazy byte accessors for a slim attachment by delegating to the
   * owning platform (e.g. iMessage's `getAttachment`). Returns `undefined` when
   * the platform exposes no such capability, in which case the attachment is
   * delivered metadata-only with a `read()`/`stream()` that throws on use.
   */
  resolveAttachment?: (
    platform: string,
    spaceRef: { id: string } & Record<string, unknown>,
    attachmentId: string
  ) => AttachmentBytes | undefined;
}

export interface DeserializeResult {
  platform: string;
  record: ProviderMessageRecord;
}

type SpaceRef = { id: string } & Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asOptionalDate = (value: unknown): Date | undefined =>
  typeof value === "string" ? new Date(value) : undefined;

/**
 * Map a native Spectrum webhook envelope to a `ProviderMessageRecord` plus the
 * platform that owns it, ready for `resolveRecordToMessages`. Returns `null`
 * when the delivery carries nothing to route (an unknown `event` type, or a
 * message with no resolvable platform) — the caller acknowledges it (200)
 * rather than failing, since neither is fixed by a retry.
 *
 * Reaction/reply targets and group items are emitted as **raw nested records**;
 * the `wrapProviderMessage`/`wrapNestedContent` pipeline turns them into
 * fully-built Messages, exactly as a provider's own `messages` handler would.
 */
export function deserializeSpectrumMessage(
  envelope: SlimEnvelope,
  ctx: DeserializeContext
): DeserializeResult | null {
  if (envelope.event !== MESSAGES_EVENT) {
    return null;
  }
  const message = envelope.message;
  const platform = resolvePlatform(message);
  if (!platform) {
    return null;
  }
  const spaceRef: SpaceRef = { ...message.space };
  return {
    platform,
    record: {
      id: message.id,
      direction: "inbound",
      content: deserializeContent(message.content, platform, spaceRef, ctx),
      space: spaceRef,
      sender: message.sender ? { ...message.sender } : undefined,
      timestamp: asOptionalDate(message.timestamp),
    },
  };
}

const resolvePlatform = (message: SlimMessage): string | undefined =>
  message.platform ?? message.space.platform;

// A wire content arm we couldn't map cleanly still reaches the handler as
// `custom` (carrying the original JSON) rather than failing the whole delivery.
const deserializeContent = (
  content: SlimContent,
  platform: string,
  spaceRef: SpaceRef,
  ctx: DeserializeContext
): Content => {
  try {
    return mapContent(content, platform, spaceRef, ctx);
  } catch {
    return asCustom(content);
  }
};

const mapContent = (
  content: SlimContent,
  platform: string,
  spaceRef: SpaceRef,
  ctx: DeserializeContext
): Content => {
  const raw = content as Record<string, unknown>;
  switch (content.type) {
    case "text":
      return { type: "text", text: asString(raw.text) };
    case "richlink":
      // Outbound-only content type; inbound URLs always surface as text.
      return { type: "text", text: asString(raw.url) };
    case "contact":
      return deserializeContact(raw);
    case "reaction":
      return deserializeReaction(raw, spaceRef);
    case "reply":
      return deserializeReply(raw, platform, spaceRef, ctx);
    case "group":
      return deserializeGroup(raw, platform, spaceRef, ctx);
    case "attachment":
      return deserializeAttachment(raw, platform, spaceRef, ctx);
    default:
      return asCustom(content);
  }
};

const deserializeAttachment = (
  raw: Record<string, unknown>,
  platform: string,
  spaceRef: SpaceRef,
  ctx: DeserializeContext
): Content => {
  const id = asString(raw.id);
  const bytes = ctx.resolveAttachment?.(platform, spaceRef, id);
  const unavailable = (): Promise<never> =>
    Promise.reject(
      UnsupportedError.action(
        "getAttachment",
        platform,
        `attachment "${id}" arrived without bytes over the Spectrum webhook and "${platform}" exposes no getAttachment`
      )
    );
  return asAttachment({
    id,
    name: asString(raw.name) || DEFAULT_ATTACHMENT_NAME,
    mimeType: asString(raw.mimeType) || DEFAULT_MIME_TYPE,
    size: typeof raw.size === "number" ? raw.size : undefined,
    read: bytes ? bytes.read : unavailable,
    stream: bytes?.stream,
  });
};

const deserializeReaction = (
  raw: Record<string, unknown>,
  spaceRef: SpaceRef
): Content =>
  // `target` is a raw record; `wrapNestedContent` wraps it into a Message.
  ({
    type: "reaction",
    emoji: asString(raw.emoji),
    target: buildTargetRecord(raw.target, spaceRef),
  }) as unknown as Content;

const deserializeReply = (
  raw: Record<string, unknown>,
  platform: string,
  spaceRef: SpaceRef,
  ctx: DeserializeContext
): Content =>
  ({
    type: "reply",
    content: isRecord(raw.content)
      ? deserializeContent(raw.content as SlimContent, platform, spaceRef, ctx)
      : asCustom(raw.content),
    target: buildTargetRecord(raw.target, spaceRef),
  }) as unknown as Content;

const buildTargetRecord = (
  target: unknown,
  spaceRef: SpaceRef
): ProviderMessageRecord => {
  const ref = (isRecord(target) ? target : {}) as Partial<SlimMessageRef>;
  return {
    id: asString(ref.id),
    // The target's full content is not delivered; the 80-char `contentPreview`
    // (text targets only) is the best available stand-in.
    content: { type: "text", text: asString(ref.contentPreview) },
    space: { ...spaceRef },
    sender: ref.sender ? { ...ref.sender } : undefined,
    timestamp: asOptionalDate(ref.timestamp),
  };
};

const deserializeGroup = (
  raw: Record<string, unknown>,
  platform: string,
  spaceRef: SpaceRef,
  ctx: DeserializeContext
): Content => {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  // Each item is a raw record; `wrapNestedContent` wraps it into a Message.
  return {
    type: "group",
    items: rawItems.map((item) =>
      buildItemRecord(item, platform, spaceRef, ctx)
    ),
  } as unknown as Content;
};

const buildItemRecord = (
  item: unknown,
  platform: string,
  spaceRef: SpaceRef,
  ctx: DeserializeContext
): ProviderMessageRecord => {
  const record = isRecord(item) ? item : {};
  const itemSpace: SpaceRef = isRecord(record.space)
    ? {
        ...(record.space as Record<string, unknown>),
        id:
          asString((record.space as Record<string, unknown>).id) || spaceRef.id,
      }
    : spaceRef;
  const content = isRecord(record.content)
    ? deserializeContent(
        record.content as SlimContent,
        platform,
        itemSpace,
        ctx
      )
    : asCustom(record.content);
  return {
    id: asString(record.id),
    content,
    space: itemSpace,
    sender: isRecord(record.sender)
      ? { ...record.sender, id: asString(record.sender.id) }
      : undefined,
    timestamp: asOptionalDate(record.timestamp),
  };
};

const deserializeContact = (raw: Record<string, unknown>): Content => {
  const input: ContactInput = {};
  const name = normalizeContactName(raw.name);
  if (name) {
    input.name = name;
  }
  const phones = normalizeContactPhones(raw.phones);
  if (phones) {
    input.phones = phones;
  }
  if (typeof raw.note === "string") {
    input.note = raw.note;
  }
  if (raw.raw !== undefined) {
    input.raw = raw.raw;
  }
  return asContact(input);
};

const CONTACT_NAME_KEYS = [
  "formatted",
  "first",
  "last",
  "middle",
  "prefix",
  "suffix",
] as const;

const normalizeContactName = (
  value: unknown
): ContactInput["name"] | undefined => {
  if (typeof value === "string") {
    return { formatted: value };
  }
  if (!isRecord(value)) {
    return;
  }
  const name: NonNullable<ContactInput["name"]> = {};
  for (const key of CONTACT_NAME_KEYS) {
    const part = value[key];
    if (typeof part === "string") {
      name[key] = part;
    }
  }
  return Object.keys(name).length > 0 ? name : undefined;
};

const normalizeContactPhones = (value: unknown): ContactPhone[] | undefined => {
  if (!Array.isArray(value)) {
    return;
  }
  const phones: ContactPhone[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      phones.push({ value: entry });
    } else if (isRecord(entry) && typeof entry.value === "string") {
      phones.push({ value: entry.value });
    }
  }
  return phones.length > 0 ? phones : undefined;
};
