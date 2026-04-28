import {
  type MessageEffect as AdvancedIMessageMessageEffect,
  MessageEffect,
} from "@photon-ai/advanced-imessage";
import { messageEffectSchema } from "../../../content/effect";
import { text } from "../../../content/text";
import type {
  Content,
  ContentBuilder,
  ContentInput,
} from "../../../content/types";

export type IMessageMessageEffect = AdvancedIMessageMessageEffect;

const SUPPORTED_EFFECTS = new Set<string>(Object.values(MessageEffect));

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
      if (inner.type !== "text" && inner.type !== "attachment") {
        throw new Error(
          `imessage effect() only supports text and attachment content, got "${inner.type}"`
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
