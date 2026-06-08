import { asCustom } from "../../../content/custom";
import { asGroup } from "../../../content/group";
import { asReaction } from "../../../content/reaction";
import type { Content } from "../../../content/types";
import type { FusorMessagesCtx } from "../../../fusor/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { Message as SpectrumMessage } from "../../../types/message";
import { botIdFromToken, type TelegramConfig } from "../config";
import type {
  Message,
  ReactionType,
  ReactionTypeEmoji,
  ReactionUpdate,
  TelegramPayload,
  User,
} from "../types";
import { messageToContent } from "./media";

const MILLIS_PER_SECOND = 1000;

// Inbound items are not full Messages yet — core's wrapProviderMessage inflates
// them. A minimal `{ id, content }` shape satisfies the `isMessage` guard used
// for group items and reaction targets.
const stubMessage = (id: string, content: Content): SpectrumMessage =>
  ({ id, content }) as unknown as SpectrumMessage;

const senderRef = (user: User) => ({
  id: String(user.id),
  ...(user.username ? { handle: user.username } : {}),
  isMe: false,
});

// One Telegram message maps to a single content (text or media), or — when a
// media message also has a caption — a `group` of [caption, media] that
// `flattenGroups` can split back into one message per part downstream.
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

const fromMessage = (
  msg: Message,
  config: TelegramConfig
): ProviderMessageRecord | undefined => {
  // Drop the bot's own messages so it never echoes itself. Telegram normally
  // doesn't deliver them, so this is belt-and-suspenders.
  if (msg.from && String(msg.from.id) === botIdFromToken(config.botToken)) {
    return;
  }
  const content = toRecordContent(
    messageToContent(msg, config),
    String(msg.message_id)
  );
  if (!content) {
    return;
  }
  return {
    id: String(msg.message_id),
    content,
    ...(msg.from ? { sender: senderRef(msg.from) } : {}),
    space: { id: String(msg.chat.id) },
    timestamp: new Date(msg.date * MILLIS_PER_SECOND),
  };
};

const emojiReactions = (reactions: ReactionType[]): string[] =>
  reactions
    .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
    .map((r) => r.emoji);

const fromReaction = (
  reaction: ReactionUpdate
): ProviderMessageRecord | undefined => {
  const added = emojiReactions(reaction.new_reaction);
  if (added.length === 0) {
    return; // Reaction removed — nothing to surface (cf. LinQ ignoring removals).
  }
  const previous = new Set(emojiReactions(reaction.old_reaction));
  const emoji = added.find((e) => !previous.has(e)) ?? added[0];
  if (!emoji) {
    return;
  }
  const target = stubMessage(
    String(reaction.message_id),
    asCustom({ telegram: "reaction-target" })
  );
  // Telegram has no event id for reactions, so synthesize a stable one. Include
  // the actor and emoji so distinct users (or emoji) reacting to the same
  // message within the same second don't collide on a shared id.
  const actorId = reaction.user ? String(reaction.user.id) : "anonymous";
  return {
    id: `reaction:${reaction.chat.id}:${reaction.message_id}:${reaction.date}:${actorId}:${emoji}`,
    content: asReaction({ emoji, target }),
    ...(reaction.user ? { sender: senderRef(reaction.user) } : {}),
    space: { id: String(reaction.chat.id) },
    timestamp: new Date(reaction.date * MILLIS_PER_SECOND),
  };
};

/**
 * Map a verified Telegram `Update` to the Spectrum message it represents. v1
 * surfaces new messages and channel posts (text + media, with captions) and
 * emoji reactions (`message_reaction`, which requires the operator to list it
 * in `allowed_updates`). Edits, callback queries, polls, membership changes and
 * other update types are ignored (return `undefined`).
 */
export const handleMessages = ({
  payload: update,
  config,
}: FusorMessagesCtx<TelegramPayload, TelegramConfig>):
  | ProviderMessageRecord
  | undefined => {
  const message = update.message ?? update.channel_post;
  if (message) {
    return fromMessage(message, config);
  }
  if (update.message_reaction) {
    return fromReaction(update.message_reaction);
  }
  return;
};
