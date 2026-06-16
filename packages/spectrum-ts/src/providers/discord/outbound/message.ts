import type { Poll } from "../../../content/poll";
import type { Content } from "../../../content/types";
import { UnsupportedError } from "../../../utils/errors";
import { toVCard } from "../../../utils/vcard";
import { DISCORD_PLATFORM } from "../config";
import { type Components, isComponents } from "../content/components";
import { type Embed, isEmbed } from "../content/embed";
import type { DiscordSendSpec } from "../types";

const VCARD_FILENAME = "contact.vcf";
const VCARD_MIME = "text/vcard";
const DEFAULT_VOICE_FILENAME = "voice.ogg";
// A bare snowflake, or a flattened group-item id of the form
// `<snowflake>:<index>`. Inbound messages carrying text + attachments are
// surfaced as a `group` whose items get synthesized ids `${messageId}:${index}`
// (see inbound/messages.ts). Every part still maps to the same underlying
// Discord message, so a reply/edit/reaction targeting any part resolves to that
// message's real snowflake — the leading capture group.
const MESSAGE_ID_PATTERN = /^(\d+)(?::\d+)?$/;

/**
 * Resolve a Spectrum message id to the Discord message snowflake the REST API
 * expects. Accepts a bare snowflake or a flattened group-item id
 * (`<snowflake>:<index>`), returning the underlying snowflake. Anything else is
 * rejected up front so a malformed `target.id` surfaces a clear error here
 * instead of a confusing 400 from Discord. Returned as a string — snowflakes
 * exceed `Number.MAX_SAFE_INTEGER`, so they are never coerced to a number.
 */
export const parseMessageId = (id: string): string => {
  const snowflake = MESSAGE_ID_PATTERN.exec(id)?.[1];
  if (!snowflake) {
    throw new Error(
      `Discord message id must be a numeric snowflake (got "${id}").`
    );
  }
  return snowflake;
};

// Map a Spectrum poll to a Discord poll-create body. Discord polls take a
// `question` (text only) and up to 10 `answers`, each carrying `poll_media`
// (text + optional emoji). Spectrum polls model only titles, so we omit
// `duration` (Discord defaults to 24h) and `allow_multiselect` (defaults to
// single-select).
const pollToSpec = (content: Poll): DiscordSendSpec => ({
  payload: {
    poll: {
      question: { text: content.title },
      answers: content.options.map((choice) => ({
        poll_media: { text: choice.title },
      })),
    },
  },
});

// Map a Discord-scoped embed to a message-create body. One Discord message
// carries up to 10 `embeds` plus optional leading `content` (text) — so an embed
// and its accompanying text go out together, unlike a `group` (N separate sends).
// Any `attachment://` files referenced by the embeds are uploaded as multipart
// parts of the same request (bytes read lazily here).
export const embedToSpec = async (content: Embed): Promise<DiscordSendSpec> => {
  const files = content.files
    ? await Promise.all(
        content.files.map(async (file) => ({
          bytes: await file.read(),
          filename: file.name,
          contentType: file.mimeType,
        }))
      )
    : undefined;
  return {
    ...(files === undefined ? {} : { files }),
    payload: {
      ...(content.content === undefined ? {} : { content: content.content }),
      embeds: content.embeds,
    },
  };
};

// Map Discord-scoped interactive components to a message-create body. One Discord
// message carries up to five action rows of buttons/select menus in `components`,
// plus optional leading `content` (text). No files are involved (components
// reference nothing external), so this is a pure object map.
export const componentsToSpec = (content: Components): DiscordSendSpec => ({
  payload: {
    ...(content.content === undefined ? {} : { content: content.content }),
    components: content.components,
  },
});

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
  // `embed` is Discord-scoped content (tagged `__platform: "Discord"`) and not a
  // member of the `Content` union, so narrow it back before the switch. Handling
  // it here — rather than only in `send` — lets an embed also be the inner content
  // of a `reply` (which recurses through `buildSend`) or an item of a `group`.
  if (isEmbed(content)) {
    return await embedToSpec(content);
  }
  // Like `embed`, interactive components are Discord-scoped content tagged
  // `__platform: "Discord"` and not a member of the `Content` union, so narrow
  // it back before the switch. Handling it here also lets components be the
  // inner content of a `reply` or an item of a `group`.
  if (isComponents(content)) {
    return componentsToSpec(content);
  }
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
    case "poll":
      return pollToSpec(content);
    case "custom":
      return customToSpec(content.raw);
    default:
      throw UnsupportedError.content(content.type, DISCORD_PLATFORM);
  }
};
