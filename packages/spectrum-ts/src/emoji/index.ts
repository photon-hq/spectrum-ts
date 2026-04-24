import { GeneratedEmoji } from "./generated";

// Friendly aliases aligned with iMessage tapback semantics. Kept separate from
// the generated file so regeneration never clobbers them. On iMessage, these
// six values are auto-converted to native tapbacks; on other platforms they
// go through as the plain emoji.
const aliases = {
  love: GeneratedEmoji.redHeart,
  like: GeneratedEmoji.thumbsUp,
  dislike: GeneratedEmoji.thumbsDown,
  laugh: GeneratedEmoji.faceWithTearsOfJoy,
  emphasize: GeneratedEmoji.doubleExclamationMark,
  question: GeneratedEmoji.redQuestionMark,
} as const;

export const Emoji = { ...GeneratedEmoji, ...aliases } as const;

export type EmojiKey = keyof typeof Emoji;
