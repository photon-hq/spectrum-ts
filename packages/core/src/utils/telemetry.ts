import { type LogAttrs, sanitizeErrorMessage } from "@photon-ai/otel";
import type { Content } from "../content/types";
import { classifyIdentifier } from "./identifier";

type RawTarget = { id?: unknown; content?: { type?: unknown } } | undefined;

const targetId = (target: RawTarget): string | undefined => {
  const id = target?.id;
  return typeof id === "string" ? id : undefined;
};

const targetType = (target: RawTarget): string | undefined => {
  const type = target?.content?.type;
  return typeof type === "string" ? type : undefined;
};

const replyOrEditAttrs = (content: Content): LogAttrs => {
  const target = (content as { target?: unknown }).target as RawTarget;
  const inner = (content as { content?: { type?: unknown } }).content;
  const innerType = inner?.type;
  return {
    "spectrum.message.content.target.id": targetId(target),
    "spectrum.message.content.target.type": targetType(target),
    "spectrum.message.content.inner.type":
      typeof innerType === "string" ? innerType : undefined,
  };
};

const unsendAttrs = (content: Content): LogAttrs => {
  const target = (content as { target?: unknown }).target as RawTarget;
  return {
    "spectrum.message.content.target.id": targetId(target),
    "spectrum.message.content.target.type": targetType(target),
  };
};

const reactionAttrs = (content: Content): LogAttrs => {
  const target = (content as { target?: unknown }).target as RawTarget;
  const emoji = (content as { emoji?: unknown }).emoji;
  return {
    "spectrum.message.content.target.id": targetId(target),
    "spectrum.message.content.reaction.emoji":
      typeof emoji === "string" ? emoji : undefined,
  };
};

const groupAttrs = (content: Content): LogAttrs => {
  const items = (content as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return {};
  }
  const types = items
    .map((item) => {
      const itemType = (item as { content?: { type?: unknown } })?.content
        ?.type;
      return typeof itemType === "string" ? itemType : undefined;
    })
    .filter((t): t is string => t !== undefined);
  return {
    "spectrum.message.content.items.count": items.length,
    "spectrum.message.content.items.types":
      types.length > 0 ? types.join(",") : undefined,
  };
};

const typingAttrs = (content: Content): LogAttrs => {
  const state = (content as { state?: unknown }).state;
  return {
    "spectrum.message.content.typing.state":
      typeof state === "string" ? state : undefined,
  };
};

const attachmentAttrs = (content: Content): LogAttrs => {
  const mime = (content as { mimeType?: unknown }).mimeType;
  const size = (content as { size?: unknown }).size;
  return {
    "spectrum.message.content.attachment.mime":
      typeof mime === "string" ? mime : undefined,
    "spectrum.message.content.attachment.size":
      typeof size === "number" ? size : undefined,
  };
};

const voiceAttrs = (content: Content): LogAttrs => {
  const mime = (content as { mimeType?: unknown }).mimeType;
  const duration = (content as { duration?: unknown }).duration;
  const size = (content as { size?: unknown }).size;
  return {
    "spectrum.message.content.voice.mime":
      typeof mime === "string" ? mime : undefined,
    "spectrum.message.content.voice.duration":
      typeof duration === "number" ? duration : undefined,
    "spectrum.message.content.voice.size":
      typeof size === "number" ? size : undefined,
  };
};

const CONTENT_ATTR_HANDLERS: Record<string, (content: Content) => LogAttrs> = {
  reply: replyOrEditAttrs,
  edit: replyOrEditAttrs,
  unsend: unsendAttrs,
  reaction: reactionAttrs,
  group: groupAttrs,
  typing: typingAttrs,
  attachment: attachmentAttrs,
  voice: voiceAttrs,
};

export function contentAttrs(content: Content | undefined): LogAttrs {
  const type = content?.type;
  if (!(content && type)) {
    return { "spectrum.message.content.type": undefined };
  }
  const handler = CONTENT_ATTR_HANDLERS[type];
  return {
    "spectrum.message.content.type": type,
    ...(handler ? handler(content) : {}),
  };
}

export function senderAttrs(sender: { id?: unknown } | undefined): LogAttrs {
  const id = sender?.id;
  if (typeof id !== "string" || id.length === 0) {
    return {};
  }
  const { kind, identifier } = classifyIdentifier(id);
  return {
    "spectrum.message.sender.id": identifier,
    "spectrum.message.sender.kind": kind,
  };
}

const attrCode = (value: unknown): string | number | undefined => {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return;
};

const causeType = (cause: unknown): string | undefined => {
  if (cause === undefined) {
    return;
  }
  return cause instanceof Error ? cause.name : typeof cause;
};

const causeMessage = (cause: unknown): string | undefined => {
  if (cause === undefined) {
    return;
  }
  const raw = cause instanceof Error ? cause.message : String(cause);
  return sanitizeErrorMessage(raw);
};

/**
 * Structured attributes for an unknown thrown value: its type, sanitized
 * message, `code`/`status` when present, and one level of `cause`. Enough to
 * debug from a log line or span without leaking PII or dumping a raw `Error`
 * (which stringifies to "[object Object]" inside an attrs object). The stack is
 * intentionally omitted — pass the `Error` as the logger's 3rd argument (or
 * wrap with `withSpan`) so it lands on the OTLP record's `exception.*` fields.
 */
export function errorAttrs(
  error: unknown,
  prefix = "spectrum.error"
): LogAttrs {
  if (!(error instanceof Error)) {
    return {
      [`${prefix}.type`]: typeof error,
      [`${prefix}.message`]: sanitizeErrorMessage(String(error)),
    };
  }
  const { code, status, cause } = error as Error & {
    cause?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    [`${prefix}.type`]: error.name,
    [`${prefix}.message`]: sanitizeErrorMessage(error.message),
    [`${prefix}.code`]: attrCode(code),
    [`${prefix}.status`]: attrCode(status),
    [`${prefix}.cause.type`]: causeType(cause),
    [`${prefix}.cause.message`]: causeMessage(cause),
  };
}
