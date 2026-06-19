import { type Content, toVCard, UnsupportedError } from "@spectrum-ts/core";
import { TELEGRAM_PLATFORM } from "../config";
import type { TelegramSendSpec } from "../types";
import { markdownToTelegramHtml } from "./markdown";

const VCARD_FILENAME = "contact.vcf";
const VCARD_MIME = "text/vcard";
const DEFAULT_VOICE_FILENAME = "voice.ogg";

/**
 * Telegram message ids are positive integers. Reject anything else up front so a
 * malformed `target.id` surfaces a clear error here instead of being coerced to
 * `NaN` and sent on to the Bot API as a confusing 400.
 */
export const parseMessageId = (id: string): number => {
  const messageId = Number(id);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    throw new Error(
      `Telegram message id must be a positive integer (got "${id}").`
    );
  }
  return messageId;
};

const customToSpec = (raw: unknown): TelegramSendSpec => {
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { method?: unknown }).method === "string"
  ) {
    const value = raw as { method: string; params?: unknown };
    const { params } = value;
    if (
      params !== undefined &&
      (typeof params !== "object" || params === null || Array.isArray(params))
    ) {
      throw new Error(
        "Telegram custom content `raw.params` must be an object when provided."
      );
    }
    return {
      method: value.method,
      params: (params ?? {}) as Record<string, unknown>,
    };
  }
  throw new Error(
    "Telegram custom content `raw` must be a `{ method, params }` Bot API call."
  );
};

const attachmentSpec = async (content: {
  name: string;
  mimeType: string;
  read: () => Promise<Buffer>;
}): Promise<TelegramSendSpec> => {
  const bytes = await content.read();
  const file = {
    field: "document",
    filename: content.name,
    mimeType: content.mimeType,
    bytes,
  };
  if (content.mimeType.startsWith("image/")) {
    return {
      method: "sendPhoto",
      params: {},
      file: { ...file, field: "photo" },
    };
  }
  if (content.mimeType.startsWith("video/")) {
    return {
      method: "sendVideo",
      params: {},
      file: { ...file, field: "video" },
    };
  }
  return { method: "sendDocument", params: {}, file };
};

/**
 * Turn one message-producing `Content` into a single Bot API call. Telegram has
 * no multi-part message — each content type is its own method/endpoint — so
 * this returns a `TelegramSendSpec` (the caller injects `chat_id` and executes
 * it). `reply` recurses and threads `reply_parameters`; `group` is NOT handled
 * here (it becomes N separate sends in `send.ts`). Fire-and-forget content
 * (reaction, typing, edit) and unsupported types never reach this function.
 */
export const buildSend = async (
  content: Content
): Promise<TelegramSendSpec> => {
  switch (content.type) {
    case "text":
      return { method: "sendMessage", params: { text: content.text } };
    case "markdown":
      return {
        method: "sendMessage",
        params: {
          text: markdownToTelegramHtml(content.markdown),
          parse_mode: "HTML",
        },
      };
    case "richlink":
      // Telegram auto-unfurls a bare URL in the message text.
      return { method: "sendMessage", params: { text: content.url } };
    case "app":
      // No mini-app surface on Telegram — send the bare URL (auto-unfurled).
      return { method: "sendMessage", params: { text: await content.url() } };
    case "attachment":
      return await attachmentSpec(content);
    case "voice": {
      const bytes = await content.read();
      return {
        method: "sendVoice",
        params:
          content.duration === undefined ? {} : { duration: content.duration },
        file: {
          field: "voice",
          filename: content.name ?? DEFAULT_VOICE_FILENAME,
          mimeType: content.mimeType,
          bytes,
        },
      };
    }
    case "contact": {
      const vcf = await toVCard(content);
      return {
        method: "sendDocument",
        params: {},
        file: {
          field: "document",
          filename: VCARD_FILENAME,
          mimeType: VCARD_MIME,
          bytes: Buffer.from(vcf, "utf8"),
        },
      };
    }
    case "reply": {
      const inner = await buildSend(content.content);
      return {
        ...inner,
        params: {
          ...inner.params,
          reply_parameters: { message_id: parseMessageId(content.target.id) },
        },
      };
    }
    case "custom":
      return customToSpec(content.raw);
    default:
      throw UnsupportedError.content(content.type, TELEGRAM_PLATFORM);
  }
};
