import {
  type Content,
  type ContentBuilder,
  type ContentInput,
  text,
} from "@spectrum-ts/core";
import { messageEffectSchema } from "@spectrum-ts/core/authoring";

export const messageEffects = {
  balloons: "com.apple.messages.effect.CKBalloonEffect",
  celebration: "com.apple.messages.effect.CKHappyBirthdayEffect",
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  echo: "com.apple.messages.effect.CKEchoEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  heart: "com.apple.messages.effect.CKHeartEffect",
  invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  slam: "com.apple.MobileSMS.expressivesend.impact",
  sparkles: "com.apple.messages.effect.CKSparklesEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
} as const;

export type IMessageMessageEffect =
  (typeof messageEffects)[keyof typeof messageEffects];

const SUPPORTED_EFFECTS = new Set<string>(Object.values(messageEffects));

const resolveContent = (input: ContentInput): Promise<Content> =>
  typeof input === "string" ? text(input).build() : input.build();

export function effect(
  input: ContentInput,
  messageEffect: IMessageMessageEffect
): ContentBuilder {
  return {
    build: async () => {
      if (!SUPPORTED_EFFECTS.has(messageEffect)) {
        throw new Error(
          `Unsupported iMessage message effect "${messageEffect}"`
        );
      }
      const inner = await resolveContent(input);
      if (
        inner.type !== "text" &&
        inner.type !== "markdown" &&
        inner.type !== "attachment"
      ) {
        throw new Error(
          `imessage effect() only supports text, markdown, and attachment content, got "${inner.type}"`
        );
      }
      return messageEffectSchema.parse({
        type: "effect",
        content: inner,
        effect: messageEffect,
      });
    },
  };
}
