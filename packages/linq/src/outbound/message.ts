import type { Content } from "spectrum-ts";
import { toVCard, UnsupportedError } from "spectrum-ts";
import type { LinqClient } from "../client";
import { LINQ_PLATFORM } from "../config";
import type { LinqOutboundMessage, LinqOutboundPart } from "../types";

const VCARD_FILENAME = "contact.vcf";
const VCARD_MIME = "text/vcard";

const uploadToPart = async (
  client: LinqClient,
  filename: string,
  contentType: string,
  bytes: Buffer
): Promise<LinqOutboundPart> => {
  const { attachmentId } = await client.uploadAttachment({
    filename,
    contentType,
    bytes,
  });
  return { type: "media", attachmentId };
};

const customToMessage = (raw: unknown): LinqOutboundMessage => {
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { parts?: unknown }).parts)
  ) {
    return raw as LinqOutboundMessage;
  }
  throw new Error(
    "LinQ custom content `raw` must be a LinQ message body with a `parts` array."
  );
};

/**
 * Turn message-producing `Content` into a LinQ message body. Attachments and
 * contacts are uploaded first and referenced by `attachment_id`; `reply` and
 * `effect` wrap an inner content's parts; `group` concatenates its items'
 * parts. Non-message content (reaction, typing, voice, …) is handled by `send`,
 * not here — anything that reaches the default is genuinely unsupported.
 */
export const buildMessage = async (
  client: LinqClient,
  content: Content
): Promise<LinqOutboundMessage> => {
  switch (content.type) {
    case "text":
      return { parts: [{ type: "text", value: content.text }] };
    case "attachment":
      return {
        parts: [
          await uploadToPart(
            client,
            content.name,
            content.mimeType,
            await content.read()
          ),
        ],
      };
    case "richlink":
      return { parts: [{ type: "link", value: content.url }] };
    case "contact": {
      const vcf = await toVCard(content);
      return {
        parts: [
          await uploadToPart(
            client,
            VCARD_FILENAME,
            VCARD_MIME,
            Buffer.from(vcf, "utf8")
          ),
        ],
      };
    }
    case "reply": {
      const inner = await buildMessage(client, content.content);
      return { ...inner, replyTo: { messageId: content.target.id } };
    }
    case "effect": {
      const inner = await buildMessage(client, content.content);
      return { ...inner, effect: { name: content.effect } };
    }
    case "group": {
      const built = await Promise.all(
        content.items.map((item) => buildMessage(client, item.content))
      );
      return { parts: built.flatMap((message) => message.parts) };
    }
    case "custom":
      return customToMessage(content.raw);
    default:
      throw UnsupportedError.content(content.type, LINQ_PLATFORM);
  }
};
