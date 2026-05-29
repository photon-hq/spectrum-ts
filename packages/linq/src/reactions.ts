import type { ReactionType } from "./types";

/**
 * Spectrum reactions are arbitrary emoji strings; LinQ models the six iMessage
 * tapbacks as an enum and everything else as a custom emoji. These maps bridge
 * the two in both directions.
 */
const TAPBACK_TO_EMOJI: Record<
  Exclude<ReactionType, "custom" | "sticker">,
  string
> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

const EMOJI_TO_TAPBACK: Record<string, ReactionType> = {
  "❤️": "love",
  "❤": "love",
  "👍": "like",
  "👎": "dislike",
  "😂": "laugh",
  "‼️": "emphasize",
  "‼": "emphasize",
  "❓": "question",
};

/** Map a Spectrum emoji to a LinQ reaction (tapback when known, else custom). */
export const emojiToReaction = (
  emoji: string
): { type: ReactionType; customEmoji?: string } => {
  const tapback = EMOJI_TO_TAPBACK[emoji];
  if (tapback) {
    return { type: tapback };
  }
  return { type: "custom", customEmoji: emoji };
};

/** Map an inbound LinQ reaction to a Spectrum emoji (undefined to drop it). */
export const tapbackToEmoji = (
  type: ReactionType,
  customEmoji?: string | null
): string | undefined => {
  if (type === "custom") {
    return customEmoji ?? undefined;
  }
  if (type === "sticker") {
    return; // Stickers aren't emoji — Spectrum reactions can't represent them.
  }
  return TAPBACK_TO_EMOJI[type];
};
