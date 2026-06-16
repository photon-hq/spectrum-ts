import type { Content } from "../../../content/types";
import { UnsupportedError } from "../../../utils/errors";
import { toVCard } from "../../../utils/vcard";
import { DISCORD_PLATFORM } from "../config";
import type { DiscordSendSpec } from "../types";

const VCARD_FILENAME = "contact.vcf";
const VCARD_MIME = "text/vcard";
const DEFAULT_VOICE_FILENAME = "voice.ogg";
const SNOWFLAKE_PATTERN = /^\d+$/;

/**
 * Discord message ids are snowflakes (numeric strings). Reject anything else up
 * front so a malformed `target.id` surfaces a clear error here instead of being
 * sent on to the REST API as a confusing 400. Returned as a string — snowflakes
 * exceed `Number.MAX_SAFE_INTEGER`, so they are never coerced to a number.
 */
export const parseMessageId = (id: string): string => {
  if (!SNOWFLAKE_PATTERN.test(id)) {
    throw new Error(
      `Discord message id must be a numeric snowflake (got "${id}").`
    );
  }
  return id;
};

const customToSpec = (raw: unknown): DiscordSendSpec => {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return { payload: raw as DiscordSendSpec["payload"] };
  }
  throw new Error(
    "Discord custom content `raw` must be an object — the JSON body for POST /channels/{id}/messages."
  );
};

/**
 * Turn one message-producing `Content` into a single Discord REST call. Discord
 * sends every kind through `POST /channels/{id}/messages` (text in `content`,
 * files as multipart parts), so this returns a `DiscordSendSpec` (the caller
 * injects `channel_id` and executes it). `reply` recurses and threads
 * `message_reference`; `group` is NOT handled here (it becomes N separate sends
 * in `send.ts`). Fire-and-forget content (reaction, typing, edit) and
 * unsupported types never reach this function.
 */
export const buildSend = async (content: Content): Promise<DiscordSendSpec> => {
  switch (content.type) {
    case "text":
      return { payload: { content: content.text } };
    // Discord renders Markdown natively, so markdown and rich links pass through
    // as message content (Discord auto-embeds a bare URL).
    case "markdown":
      return { payload: { content: content.markdown } };
    case "richlink":
      return { payload: { content: content.url } };
    case "attachment": {
      const bytes = await content.read();
      return {
        payload: {},
        files: [
          { bytes, filename: content.name, contentType: content.mimeType },
        ],
      };
    }
    case "voice": {
      const bytes = await content.read();
      return {
        payload: {},
        files: [
          {
            bytes,
            filename: content.name ?? DEFAULT_VOICE_FILENAME,
            contentType: content.mimeType,
          },
        ],
      };
    }
    case "contact": {
      const vcf = await toVCard(content);
      return {
        payload: {},
        files: [
          {
            bytes: Buffer.from(vcf, "utf8"),
            filename: VCARD_FILENAME,
            contentType: VCARD_MIME,
          },
        ],
      };
    }
    case "reply": {
      const inner = await buildSend(content.content);
      return {
        ...inner,
        payload: {
          ...inner.payload,
          message_reference: { message_id: parseMessageId(content.target.id) },
        },
      };
    }
    case "custom":
      return customToSpec(content.raw);
    default:
      throw UnsupportedError.content(content.type, DISCORD_PLATFORM);
  }
};
