import { asCustom } from "../../../content/custom";
import { asReaction } from "../../../content/reaction";
import type { ProviderMessageRecord } from "../../../platform/build";
import type { Message as SpectrumMessage } from "../../../types/message";
import type { MessageReactionUpdated, ReactionType } from "../generated/types";
import { chatToSender, chatToSpace, userToSender } from "../identity";
import { messageCacheKey, type TelegramCache } from "../runtime/cache";
import type { TelegramMessage } from "../types";

// `message_reaction` carries a diff (`old_reaction` vs `new_reaction`).
// Spectrum's `reaction` content is add-only and plain-unicode, so we emit
// only the newly-added emoji reactions. Removes, custom emoji, and paid
// reactions are dropped pending schema additions.
//
// TODO(reactions): emit remove events once `reactionSchema` has an action.
// TODO(reactions): surface custom emoji once the schema carries id+kind.
// TODO(reactions): consider `message_reaction_count` snapshots for
//   anonymous channels.

const extractEmoji = (reaction: ReactionType): string | undefined => {
  if (reaction.type !== "emoji") {
    return undefined;
  }
  return reaction.emoji ? reaction.emoji : undefined;
};

const newlyAddedEmojis = (update: MessageReactionUpdated): string[] => {
  const previous = new Set(
    update.old_reaction.map(extractEmoji).filter((e): e is string => !!e)
  );
  const added: string[] = [];
  for (const reaction of update.new_reaction) {
    const emoji = extractEmoji(reaction);
    if (emoji && !previous.has(emoji)) {
      added.push(emoji);
    }
  }
  return added;
};

// `message_reaction` carries only the target's message id, so we either
// hand back the cached record or synthesize a minimal stub. The platform's
// `wrapProviderMessage` inflates either shape into a full `Message`.
const reactionTargetStub = (
  messageId: number,
  space: ReturnType<typeof chatToSpace>,
  timestamp: Date
): ProviderMessageRecord => ({
  id: String(messageId),
  content: asCustom({ telegram_type: "reaction-target", stub: true }),
  sender: { id: "__unknown__" },
  space,
  timestamp,
});

const resolveReactionTarget = (
  cache: TelegramCache,
  messageId: number,
  space: ReturnType<typeof chatToSpace>,
  timestamp: Date
): TelegramMessage | ProviderMessageRecord => {
  const cached = cache.messages.get(messageCacheKey(space.id, messageId));
  if (cached) {
    return cached;
  }
  return reactionTargetStub(messageId, space, timestamp);
};

export const reactionEventsFromUpdate = (
  update: MessageReactionUpdated,
  updateId: number,
  cache: TelegramCache
): TelegramMessage[] => {
  // Anonymous channel admins arrive as `actor_chat`; treat as sender via
  // `chatToSender` so the reaction isn't silently dropped.
  let sender: ReturnType<typeof userToSender>;
  if (update.user) {
    sender = userToSender(update.user);
  } else if (update.actor_chat) {
    sender = chatToSender(update.actor_chat);
  } else {
    return [];
  }
  const space = chatToSpace(update.chat);
  const timestamp = new Date(update.date * 1000);
  const target = resolveReactionTarget(
    cache,
    update.message_id,
    space,
    timestamp
  );
  // `asReaction` is typed against the rich `Message` (with `react()` /
  // `reply()` closures); the platform inflates the raw record downstream.
  return newlyAddedEmojis(update).map((emoji, index) => ({
    id: `reaction:${updateId}:${index}`,
    content: asReaction({
      emoji,
      target: target as unknown as SpectrumMessage,
    }),
    sender,
    space,
    timestamp,
  }));
};
