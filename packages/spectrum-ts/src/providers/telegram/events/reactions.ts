import { asCustom } from "../../../content/custom";
import { asReaction } from "../../../content/reaction";
import type { ProviderMessageRecord } from "../../../platform/build";
import type { Message as SpectrumMessage } from "../../../types/message";
import type { MessageReactionUpdated, ReactionType } from "../generated/types";
import { messageCacheKey, type TelegramCache } from "../runtime/cache";
import type { TelegramMessage } from "../types";
import { chatToSender, chatToSpace, userToSender } from "./inbound";

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

// `asReaction({ target })` is typed against the rich `Message` interface
// (with `react()` / `reply()` closures), but the Zod `isMessage` guard
// inside `reactionSchema` is structural — only `id` + `content` are
// checked. Both our cache-hit (`TelegramMessage`) and stub
// (`ProviderMessageRecord`) shapes satisfy that guard. We localize the
// erasure here, mirroring the `toGroupItems` helper pattern used for
// `asGroup`, so the cast lives in one named, commented place instead of
// scattered through call sites.
const toReactionTarget = (
  record: TelegramMessage | ProviderMessageRecord
): SpectrumMessage => record as unknown as SpectrumMessage;

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

// Resolve the reaction's target to whatever we know about it. Cache hits
// return the rich `TelegramMessage` directly; misses fall back to the
// minimal `ProviderMessageRecord` stub. Both shapes implement the
// structural contract `asReaction` requires (see `toReactionTarget`).
const resolveReactionTarget = (
  cache: TelegramCache,
  messageId: number,
  space: ReturnType<typeof chatToSpace>,
  timestamp: Date
): TelegramMessage | ProviderMessageRecord => {
  // Composite key: `message_id` is per-chat in Telegram, so include the
  // space (`String(chat.id)`) to avoid resolving to a same-numbered message
  // from a different chat the bot is also active in.
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
  // Telegram populates either `user` (a real account) or `actor_chat` (an
  // anonymous channel admin reacting on the channel's behalf). Falling back
  // to `actor_chat` via `chatToSender` keeps these reactions visible end-to-
  // end instead of silently dropping them — matches the inbound message path
  // which already handles `sender_chat` the same way. If both fields are
  // absent the update is malformed and we bail.
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
  const reactionTarget = toReactionTarget(target);
  return newlyAddedEmojis(update).map((emoji, index) => ({
    // update_id is unique per update, message_id is the *target* of the
    // reaction (not the reaction's own id — Telegram doesn't surface one), so
    // compose a stable id per emitted event.
    id: `reaction:${updateId}:${index}`,
    content: asReaction({ emoji, target: reactionTarget }),
    sender,
    space,
    timestamp,
  }));
};
