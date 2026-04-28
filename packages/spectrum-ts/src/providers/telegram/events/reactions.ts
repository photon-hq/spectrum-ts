import { asCustom } from "../../../content/custom";
import { asReaction } from "../../../content/reaction";
import type { ProviderMessageRecord } from "../../../platform/build";
import type { MessageReactionUpdated, ReactionType } from "../generated/types";
import type { TelegramCache } from "../runtime/cache";
import type { TelegramMessage } from "../types";
import { chatToSpace, userToSender } from "./inbound";

// ---------------------------------------------------------------------------
// Reactions (inbound)
//
// Telegram's `message_reaction` update carries a diff (`old_reaction` vs
// `new_reaction`) per user per message. Spectrum's `reaction` content is
// add-only and plain-unicode, so we only emit the newly-added emoji
// reactions from each update. Everything else is deliberately skipped with
// a comment so the gap is grep-able once the schema grows richer.
//
// TODO(reactions): when `reactionSchema` gains `action: "add" | "remove"`,
//   emit remove events for emojis that left `new_reaction`.
// TODO(reactions): when `reactionSchema` can carry custom emoji (e.g. an
//   `emojiKind: "custom"` + id field), surface ReactionTypeCustomEmoji.
//   Paid reactions have no emoji payload and will likely stay dropped.
// TODO(reactions): consider surfacing `message_reaction_count` as a
//   separate snapshot content type for anonymous channels.
// ---------------------------------------------------------------------------

// Defensive against schema drift: `ReactionType{emoji}` declares `emoji` as
// required, but upstream Telegram payloads have historically omitted fields
// during API transitions. Treat a missing/empty string as "no reaction" to
// keep the diff against `old_reaction` correct instead of emitting `""`.
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

// Telegram's `message_reaction` update only gives us the target's message id
// (not the original sender, content, or anything else). PR #33 narrowed
// `reaction.target` to `Message`, so when we have the target cached we hand
// back the real prior message; otherwise we synthesize a minimal raw record
// and let core's `wrapProviderMessage` inflate it into a full `Message`.
//
// Hit and miss paths converge on the same wrap pipeline: even on a cache
// hit, the cached `TelegramMessage` is structurally a `ProviderMessageRecord`
// (sans the `react`/`reply` closures, which `wrapProviderMessage` adds back
// during inflation), so passing it as `target` is consistent with the miss
// path — no double-wrapping, no special casing in `messages.ts`.
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
): ProviderMessageRecord => {
  const cached = cache.messages.get(String(messageId));
  if (cached) {
    return cached as unknown as ProviderMessageRecord;
  }
  return reactionTargetStub(messageId, space, timestamp);
};

export const reactionEventsFromUpdate = (
  update: MessageReactionUpdated,
  updateId: number,
  cache: TelegramCache
): TelegramMessage[] => {
  // Anonymous actors (actor_chat, no user) can't produce a Spectrum sender; the
  // content-type carries no "chat reactor" concept today. Drop for now.
  if (!update.user) {
    return [];
  }
  const sender = userToSender(update.user);
  const space = chatToSpace(update.chat);
  const timestamp = new Date(update.date * 1000);
  const target = resolveReactionTarget(
    cache,
    update.message_id,
    space,
    timestamp
  );
  return newlyAddedEmojis(update).map((emoji, index) => ({
    // update_id is unique per update, message_id is the *target* of the
    // reaction (not the reaction's own id — Telegram doesn't surface one), so
    // compose a stable id per emitted event.
    id: `reaction:${updateId}:${index}`,
    content: asReaction({
      emoji,
      target: target as unknown as Parameters<typeof asReaction>[0]["target"],
    }),
    sender,
    space,
    timestamp,
  }));
};
