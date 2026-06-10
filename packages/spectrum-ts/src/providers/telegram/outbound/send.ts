import {
  editMessageText,
  sendChatAction,
  setMessageReaction,
} from "@photon-ai/telegram-ts";
import type { Edit } from "../../../content/edit";
import type { Reaction } from "../../../content/reaction";
import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import { UnsupportedError } from "../../../utils/errors";
import { executeSpec, type TelegramClient, telegramClient } from "../client";
import { TELEGRAM_PLATFORM, type TelegramConfig } from "../config";
import { isAllowedReactionEmoji, normalizeReactionEmoji } from "../reactions";
import type { TelegramSpace } from "../space";
import type { ReactionTypeEmoji } from "../types";
import { buildSend, parseMessageId } from "./message";

const MILLIS_PER_SECOND = 1000;

interface SendArgs {
  config: TelegramConfig;
  content: Content;
  space: TelegramSpace;
}

/** Build one content's spec, inject `chat_id`, execute it, return the record. */
const sendContent = async (
  client: TelegramClient,
  space: TelegramSpace,
  content: Content
): Promise<ProviderMessageRecord> => {
  const spec = await buildSend(content);
  const sent = await executeSpec(client, {
    ...spec,
    params: { chat_id: space.id, ...spec.params },
  });
  return {
    id: String(sent.message_id),
    content,
    space: { id: space.id },
    timestamp: new Date(sent.date * MILLIS_PER_SECOND),
  };
};

// A Spectrum `group` has no single-message equivalent on Telegram, so each item
// is sent as its own message. The last sent message is returned as "the"
// record (most-recent id is the natural threading target).
const sendGroup = async (
  client: TelegramClient,
  space: TelegramSpace,
  items: { content: Content }[]
): Promise<ProviderMessageRecord | undefined> => {
  let last: ProviderMessageRecord | undefined;
  for (const item of items) {
    last = await sendContent(client, space, item.content);
  }
  return last;
};

const sendReaction = async (
  client: TelegramClient,
  space: TelegramSpace,
  content: Reaction
): Promise<ProviderMessageRecord> => {
  const messageId = parseMessageId(content.target.id);
  const emoji = normalizeReactionEmoji(content.emoji);
  // Validate before calling: setMessageReaction only accepts a fixed emoji set
  // in non-premium chats. Checking up front gives a clear error and avoids
  // mis-attributing an unrelated API failure (network, rate limit) to the emoji.
  if (!isAllowedReactionEmoji(emoji)) {
    throw UnsupportedError.content(
      "reaction",
      TELEGRAM_PLATFORM,
      `"${content.emoji}" is not an allowed Telegram reaction emoji.`
    );
  }
  await setMessageReaction({
    body: {
      chat_id: space.id,
      message_id: messageId,
      // `emoji` is runtime-validated above; cast to photon's allowed-emoji union.
      reaction: [{ emoji: emoji as ReactionTypeEmoji["emoji"], type: "emoji" }],
    },
    client,
  });
  // setMessageReaction returns only `true`; Telegram assigns no id to the
  // bot's reaction and never echoes it back as an update. Mirror the inbound
  // id format (inbound/messages.ts) with `bot` as the actor.
  const timestamp = new Date();
  const unixSeconds = Math.floor(timestamp.getTime() / MILLIS_PER_SECOND);
  return {
    id: `reaction:${space.id}:${messageId}:${unixSeconds}:bot:${emoji}`,
    content,
    space: { id: space.id },
    timestamp,
  };
};

const sendTyping = async (
  client: TelegramClient,
  space: TelegramSpace,
  state: "start" | "stop"
): Promise<undefined> => {
  // Telegram has no "stop typing" — the indicator auto-clears after ~5s.
  if (state === "start") {
    await sendChatAction({
      body: { action: "typing", chat_id: space.id },
      client,
    });
  }
  return;
};

const sendEdit = async (
  client: TelegramClient,
  space: TelegramSpace,
  content: Edit
): Promise<undefined> => {
  if (content.content.type !== "text") {
    throw UnsupportedError.content(
      "edit",
      TELEGRAM_PLATFORM,
      `only text content can be edited (got "${content.content.type}").`
    );
  }
  await editMessageText({
    body: {
      chat_id: space.id,
      message_id: parseMessageId(content.target.id),
      text: content.content.text,
    },
    client,
  });
  return;
};

/**
 * Outbound dispatcher. Fire-and-forget signals (typing, edit) return
 * `undefined`; message-producing content returns a record with the Telegram
 * message id. Reactions return a record with a synthetic id (Telegram assigns
 * none). A `group` fans out to one message per item. `poll`, `effect`,
 * `rename` and `avatar` are unsupported in v1 (use `custom` to reach any other
 * Bot API method directly).
 */
export const send = async ({
  space,
  content,
  config,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  const client = telegramClient(config);
  switch (content.type) {
    case "reaction":
      return await sendReaction(client, space, content);
    case "typing":
      return await sendTyping(client, space, content.state);
    case "edit":
      return await sendEdit(client, space, content);
    case "group":
      return await sendGroup(client, space, content.items);
    case "poll":
    case "poll_option":
    case "effect":
    case "rename":
    case "avatar":
      throw UnsupportedError.content(content.type, TELEGRAM_PLATFORM);
    default:
      return await sendContent(client, space, content);
  }
};
