import { asCustom } from "../../../content/custom";
import { asEdit } from "../../../content/edit";
import { asGroup } from "../../../content/group";
import { asReaction } from "../../../content/reaction";
import { asText } from "../../../content/text";
import type { BaseContent, Content } from "../../../content/types";
import { asUnsend } from "../../../content/unsend";
import type { FusorMessagesCtx } from "../../../fusor/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { Message as SpectrumMessage } from "../../../types/message";
import type { DiscordConfig } from "../config";
import {
  type DiscordPayload,
  type DiscordUser,
  DispatchEvent,
  type MessageCreate,
  type MessageDelete,
  type MessageReactionAdd,
  type MessageReactionRemove,
  type MessageUpdate,
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
const messageToContents = (
  msg: Pick<MessageCreate, "attachments" | "content">
): Content[] => {
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

const fromMessageUpdate = (
  msg: MessageUpdate,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Discord also fires MESSAGE_UPDATE for partial changes it makes itself (e.g.
  // auto-attaching a link embed), where no author is present. Without an author
  // there's nothing to attribute the edit to, so ignore it. Then drop the bot's
  // own edits so it never re-ingests messages it sent.
  if (!msg.author || msg.author.id === config.applicationId) {
    return;
  }
  const content = toRecordContent(messageToContents(msg), msg.id);
  if (!content) {
    return;
  }
  // The edited message is the sender's own message, so tag the target stub
  // `inbound` — otherwise wrapProviderMessage defaults an edit target to
  // outbound (the usual case, where we're rewriting one of our own messages).
  const target = {
    id: msg.id,
    content: asCustom({ discord: "edit-target" }),
    direction: "inbound",
  } as unknown as SpectrumMessage;
  // MESSAGE_UPDATE reuses the original message id, so synthesize a distinct
  // event id (mirroring reactions) to keep the edit from colliding with the
  // MESSAGE_CREATE it amends.
  return {
    id: `edit:${msg.channel_id}:${msg.id}`,
    content: asEdit({ content: content as BaseContent, target }),
    sender: senderRef(msg.author),
    space: { id: msg.channel_id },
    timestamp: new Date(msg.edited_timestamp ?? Date.now()),
  };
};

// Discord reaction events assign no event id, so synthesize a stable one from
// the actor, target and emoji. Add and remove derive the same id for a given
// reaction so a removal's `unsend` resolves back to the reaction it retracts.
const reactionEventId = (
  reaction: MessageReactionAdd | MessageReactionRemove,
  emoji: string
): string =>
  `reaction:${reaction.channel_id}:${reaction.message_id}:${reaction.user_id}:${emoji}`;

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
  // Discord reaction events carry only the reactor and target, not the original
  // author, so the synthesized sender is the reactor.
  return {
    id: reactionEventId(reaction, emoji),
    content: asReaction({ emoji, target }),
    sender: { id: reaction.user_id, isMe: false },
    space: { id: reaction.channel_id },
    timestamp: new Date(),
  };
};

const fromReactionRemove = (
  reaction: MessageReactionRemove,
  config: DiscordConfig
): ProviderMessageRecord | undefined => {
  // Mirror fromReaction: ignore the bot's own reaction removals and custom
  // emoji with no name.
  if (reaction.user_id === config.applicationId) {
    return;
  }
  const emoji = reaction.emoji.name;
  if (!emoji) {
    return; // Custom emoji with no name — nothing to surface.
  }
  // Removing a reaction retracts it, so map it to an `unsend` whose target is
  // the reaction the add handler surfaced. Reuse that handler's synthesized id
  // (via reactionEventId) so the unsend resolves to the same reaction, and tag
  // the stub `inbound` since it's the user's own reaction (not one of ours).
  const target = {
    id: reactionEventId(reaction, emoji),
    content: asCustom({ discord: "unsend-target" }),
    direction: "inbound",
  } as unknown as SpectrumMessage;
  return {
    id: `reaction-remove:${reaction.channel_id}:${reaction.message_id}:${reaction.user_id}:${emoji}`,
    content: asUnsend({ target }),
    sender: { id: reaction.user_id, isMe: false },
    space: { id: reaction.channel_id },
    timestamp: new Date(),
  };
};

const fromMessageDelete = (msg: MessageDelete): ProviderMessageRecord => {
  // MESSAGE_DELETE carries only the id of the removed message — no author or
  // content — so map it to an `unsend` retracting that message. Tag the target
  // stub `inbound` (mirroring the edit target) since it's the user's own
  // message rather than one of ours.
  const target = {
    id: msg.id,
    content: asCustom({ discord: "unsend-target" }),
    direction: "inbound",
  } as unknown as SpectrumMessage;
  // The delete reuses the original message id, so synthesize a distinct event
  // id to keep it from colliding with the MESSAGE_CREATE it retracts.
  return {
    id: `delete:${msg.channel_id}:${msg.id}`,
    content: asUnsend({ target }),
    space: { id: msg.channel_id },
    timestamp: new Date(),
  };
};

/**
 * Map a relayed Discord Gateway dispatch to the Spectrum message it represents.
 * v1 surfaces new messages (text + attachments, fanned out as a group), edits
 * (`MESSAGE_UPDATE`, mapped to an `edit` rewriting the original message), and
 * emoji reactions (`MESSAGE_REACTION_ADD`). Deletes (`MESSAGE_DELETE`) and
 * reaction removals (`MESSAGE_REACTION_REMOVE`) map to `unsend`s retracting the
 * message or reaction. Typing, presence and every other dispatch type are
 * ignored (return `undefined`).
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
    case DispatchEvent.MESSAGE_UPDATE:
      return fromMessageUpdate(payload.d as MessageUpdate, config);
    case DispatchEvent.MESSAGE_DELETE:
      return fromMessageDelete(payload.d as MessageDelete);
    case DispatchEvent.MESSAGE_REACTION_ADD:
      return fromReaction(payload.d as MessageReactionAdd, config);
    case DispatchEvent.MESSAGE_REACTION_REMOVE:
      return fromReactionRemove(payload.d as MessageReactionRemove, config);
    default:
      return;
  }
};
