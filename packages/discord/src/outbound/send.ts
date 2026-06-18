import type { MessageCreateRequest } from "@photon-ai/discord-ts";
import {
  type Content,
  type Edit,
  type Reaction,
  UnsupportedError,
} from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";
import {
  addReaction,
  createChannelMessage,
  type DiscordClient,
  discordClient,
  editChannelMessage,
  triggerTyping,
} from "../client";
import { DISCORD_PLATFORM, type DiscordConfig } from "../config";
import type { DiscordSpace } from "../space";
import { buildSend, parseMessageId } from "./message";

interface SendArgs {
  config: DiscordConfig;
  content: Content;
  space: DiscordSpace;
}

// Every mention type, parsed — the implicit Discord default when no
// `allowed_mentions` is sent.
const ALL_MENTION_TYPES = ["users", "roles", "everyone"] as const;

/**
 * Resolve the `allowed_mentions` to attach to an outbound message. Precedence:
 * (1) a value the content already set (only `custom` can) wins verbatim; (2) the
 * provider config's `allowedMentions`, with `replied_user` defaulted to `false`
 * unless pinned; (3) otherwise the safe default — parse every mention type, so
 * in-content `@mentions` ping exactly as before, but never ping the replied-to
 * author. Sending `allowed_mentions` on a non-reply is harmless (Discord ignores
 * `replied_user` without a `message_reference`), so this applies uniformly and
 * lets `config.allowedMentions` govern mentions globally.
 */
export const resolveAllowedMentions = (
  config: DiscordConfig,
  existing: MessageCreateRequest["allowed_mentions"]
): MessageCreateRequest["allowed_mentions"] => {
  if (existing != null) {
    return existing;
  }
  const configured = config.allowedMentions;
  if (configured) {
    return configured.replied_user === undefined
      ? { ...configured, replied_user: false }
      : configured;
  }
  return { parse: [...ALL_MENTION_TYPES], replied_user: false };
};

/** Build one content's spec, send it to the channel, return the record. */
const sendContent = async (
  client: DiscordClient,
  space: DiscordSpace,
  content: Content,
  config: DiscordConfig
): Promise<ProviderMessageRecord> => {
  const spec = await buildSend(content);
  spec.payload.allowed_mentions = resolveAllowedMentions(
    config,
    spec.payload.allowed_mentions
  );
  const sent = await createChannelMessage(client, space.id, spec);
  return {
    id: sent.id,
    content,
    space: { id: space.id },
    timestamp: new Date(sent.timestamp),
  };
};

// A Spectrum `group` maps to one Discord message per item (Discord has no
// single multi-content message beyond attachments). The last sent message is
// returned as "the" record — the most-recent id is the natural reply target.
const sendGroup = async (
  client: DiscordClient,
  space: DiscordSpace,
  items: { content: Content }[],
  config: DiscordConfig
): Promise<ProviderMessageRecord | undefined> => {
  let last: ProviderMessageRecord | undefined;
  for (const item of items) {
    last = await sendContent(client, space, item.content, config);
  }
  return last;
};

const sendReaction = async (
  client: DiscordClient,
  space: DiscordSpace,
  content: Reaction
): Promise<ProviderMessageRecord> => {
  const messageId = parseMessageId(content.target.id);
  await addReaction(client, space.id, messageId, content.emoji);
  // Discord assigns no id to a reaction and never echoes the bot's own back, so
  // synthesize a stable id from the channel, target and emoji.
  return {
    id: `reaction:${space.id}:${messageId}:${content.emoji}`,
    content,
    space: { id: space.id },
    timestamp: new Date(),
  };
};

const sendEdit = async (
  client: DiscordClient,
  space: DiscordSpace,
  content: Edit
): Promise<undefined> => {
  const inner = content.content;
  if (inner.type !== "text" && inner.type !== "markdown") {
    throw UnsupportedError.content(
      "edit",
      DISCORD_PLATFORM,
      `only text and markdown content can be edited (got "${inner.type}").`
    );
  }
  const text = inner.type === "markdown" ? inner.markdown : inner.text;
  await editChannelMessage(
    client,
    space.id,
    parseMessageId(content.target.id),
    {
      content: text,
    }
  );
  return;
};

/**
 * Outbound dispatcher. Fire-and-forget signals (typing, edit) return
 * `undefined`; message-producing content returns a record with the Discord
 * message id. Reactions return a record with a synthetic id (Discord assigns
 * none). A `group` fans out to one message per item. A `poll` is sent as a
 * native Discord poll. Discord-scoped `embed` (one message with up to 10 embeds
 * + optional text/files) and `components` (up to five action rows of
 * buttons/select menus + optional text) fall through to `sendContent`, where
 * `buildSend` maps them (and also handles each as the inner content of a
 * `reply`/`group`).
 * `streamText`, `poll_option`, `effect`, `rename` and `avatar` are unsupported in
 * v1 (`poll_option` because bots cannot cast poll votes; use `custom` to reach any
 * other message-create body directly).
 */
export const send = async ({
  space,
  content,
  config,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  const client = discordClient(config);
  switch (content.type) {
    case "reaction":
      return await sendReaction(client, space, content);
    case "typing":
      // Discord has no "stop typing" — the indicator auto-clears after ~10s.
      if (content.state === "start") {
        await triggerTyping(client, space.id);
      }
      return;
    case "read":
      // Discord bots cannot mark messages read (no read-receipt API), so the
      // request is vacuously satisfied. Silent no-op keeps `message.read()`
      // portable across platforms.
      return;
    case "edit":
      return await sendEdit(client, space, content);
    case "group":
      return await sendGroup(client, space, content.items, config);
    case "streamText":
    case "poll_option":
    case "effect":
    case "rename":
    case "avatar":
      throw UnsupportedError.content(content.type, DISCORD_PLATFORM);
    default:
      return await sendContent(client, space, content, config);
  }
};
