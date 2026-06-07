/**
 * Telegram reactions ARE emoji (unlike LinQ's tapback enum), so inbound and
 * outbound need no translation — the emoji string maps straight to/from
 * Spectrum. The catch: `setMessageReaction` only accepts a fixed set of
 * standard emoji in non-premium chats; anything else fails with
 * `REACTION_INVALID`. This set is exported so callers can pre-check, and the
 * send path uses it to turn that API error into a clearer message.
 *
 * Source: the default `available_reactions` documented for the Bot API. The set
 * is stable but Telegram can extend it; treat membership as a best-effort hint,
 * not a hard guarantee.
 */
export const ALLOWED_REACTION_EMOJI: ReadonlySet<string> = new Set([
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
]);

const VARIATION_SELECTOR_16 = /️/g;

const stripVariationSelector = (emoji: string): string =>
  emoji.replace(VARIATION_SELECTOR_16, "");

/**
 * Telegram's reaction set uses bare codepoints (no U+FE0F variation selector),
 * while clients/Spectrum often carry the emoji-presentation form (e.g. `❤️`).
 * Strip the selector before comparing so both forms validate.
 */
export const isAllowedReactionEmoji = (emoji: string): boolean =>
  ALLOWED_REACTION_EMOJI.has(stripVariationSelector(emoji));

/**
 * The form to send to `setMessageReaction`. Known reactions are normalized to
 * the bare codepoint Telegram expects; unknown emoji pass through unchanged so
 * the API's own validation (and our clearer error) can take over.
 */
export const normalizeReactionEmoji = (emoji: string): string =>
  isAllowedReactionEmoji(emoji) ? stripVariationSelector(emoji) : emoji;
