import { asCustom } from "../../../content/custom";
import { asGroup } from "../../../content/group";
import { asReaction } from "../../../content/reaction";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import type { FusorMessagesCtx } from "../../../fusor/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { Message as SpectrumMessage } from "../../../types/message";
import type { DiscordConfig } from "../config";
import {
  type DiscordPayload,
  type DiscordUser,
  DispatchEvent,
  type MessageCreate,
  type MessageReactionAdd,
} from "../types";
import { attachmentToContent } from "./media";

// Inbound items are not full Messages yet — core's wrapProviderMessage inflates
// them. A minimal `{ id, content }` shape satisfies the `isMessage` guard used
// for group items and reaction targets.
const stubMessage = (id: string, content: Content): SpectrumMessage =>
  ({ id, content }) as unknown as SpectrumMessage;

const senderRef = (user: DiscordUser) => ({
  id: user.id,
  handle: user.username,
  isMe: Boolean(user.bot),
});

// A Discord message can carry text and several attachments at once. Surface a
// single content when there's only one, or a `group` of [text, ...files] that
// `flattenGroups` splits back into one message per part downstream.
const toRecordContent = (
  contents: Content[],
  messageId: string
): Content | undefined => {
  if (contents.length === 0) {
    return;
  }
  if (contents.length === 1) {
    return contents[0];
  }
  return asGroup({
    items: contents.map((content, index) =>
      stubMessage(`${messageId}:${index}`, content)
    ),
  });
};

// Map a message's text + attachments to Spectrum content parts: the trimmed
// `content` as a leading text part (if any) followed by one part per attachment.
const messageToContents = (msg: MessageCreate): Content[] => {
  const contents: Content[] = [];
  const text = msg.content.trim();
  if (text.length > 0) {
    contents.push(asText(text));
  }
  for (const file of msg.attachments) {
    contents.push(attachmentToContent(file));
  }
  return contents;
};

const fromMessage = (
  msg: MessageCreate,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Drop the bot's own messages so it never echoes itself. A bot's user id
  // equals its application id.
  if (msg.author.id === config.applicationId) {
    return;
  }
  const content = toRecordContent(messageToContents(msg), msg.id);
  if (!content) {
    return;
  }
  return {
    id: msg.id,
    content,
    sender: senderRef(msg.author),
    space: { id: msg.channel_id },
    timestamp: new Date(msg.timestamp),
  };
};

const fromReaction = (
  reaction: MessageReactionAdd,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Ignore the bot's own reactions (mirrors dropping its own messages).
  if (reaction.user_id === config.applicationId) {
    return;
  }
  const emoji = reaction.emoji.name;
  if (!emoji) {
    return; // Custom emoji with no name — nothing to surface.
  }
  const target = stubMessage(
    reaction.message_id,
    asCustom({ discord: "reaction-target" })
  );
  // Discord reaction events carry only the reactor and target — not the original
  // author — and assign no event id, so synthesize a stable one from the actor,
  // target and emoji.
  return {
    id: `reaction:${reaction.channel_id}:${reaction.message_id}:${reaction.user_id}:${emoji}`,
    content: asReaction({ emoji, target }),
    sender: { id: reaction.user_id, isMe: false },
    space: { id: reaction.channel_id },
    timestamp: new Date(),
  };
};

/**
 * Map a relayed Discord Gateway dispatch to the Spectrum message it represents.
 * v1 surfaces new messages (text + attachments, fanned out as a group) and
 * emoji reactions (`MESSAGE_REACTION_ADD`). Edits, deletes, reaction removals,
 * typing, presence and every other dispatch type are ignored (return
 * `undefined`).
 */
export const handleMessages = ({
  payload,
  config,
}: FusorMessagesCtx<DiscordPayload, DiscordConfig>):
  | ProviderMessageRecord
  | undefined => {
  switch (payload.t) {
    case DispatchEvent.MESSAGE_CREATE:
      return fromMessage(payload.d as MessageCreate, config);
    case DispatchEvent.MESSAGE_REACTION_ADD:
      return fromReaction(payload.d as MessageReactionAdd, config);
    default:
      return;
  }
};
