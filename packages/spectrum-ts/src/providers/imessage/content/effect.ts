import {
  type MessageEffect as AdvancedIMessageMessageEffect,
  MessageEffect,
} from "@photon-ai/advanced-imessage";
import { text } from "../../../content/text";
import type {
  Content,
  ContentBuilder,
  ContentInput,
} from "../../../content/types";
import { IMESSAGE_PLATFORM } from "../shared/errors";

const MESSAGE_EFFECT_VALUES = new Set<string>(Object.values(MessageEffect));

export type IMessageMessageEffect = AdvancedIMessageMessageEffect;

type EffectContent = Extract<Content, { type: "attachment" | "text" }>;

type IMessageMessageEffectContent = EffectContent & {
  readonly __platform: typeof IMESSAGE_PLATFORM;
  readonly effect: IMessageMessageEffect;
};

const isEffectContent = (content: Content): content is EffectContent =>
  content.type === "text" || content.type === "attachment";

const rawEffect = (content: Content): string | undefined => {
  if (!isEffectContent(content)) {
    return;
  }
  const platform = (content as { __platform?: unknown }).__platform;
  const effect = (content as { effect?: unknown }).effect;
  if (platform !== IMESSAGE_PLATFORM || typeof effect !== "string") {
    return;
  }
  return effect;
};

const isIMessageMessageEffectContent = (
  content: Content
): content is IMessageMessageEffectContent => {
  const effect = rawEffect(content);
  return effect !== undefined && MESSAGE_EFFECT_VALUES.has(effect);
};

const assertMessageEffect = (
  messageEffect: IMessageMessageEffect
): IMessageMessageEffect => {
  if (!MESSAGE_EFFECT_VALUES.has(messageEffect)) {
    throw new Error(`Unsupported iMessage message effect "${messageEffect}"`);
  }
  return messageEffect;
};

const resolveContent = (input: ContentInput): Promise<Content> =>
  typeof input === "string" ? text(input).build() : input.build();

export const getIMessageMessageEffect = (
  content: Content
): IMessageMessageEffect | undefined => {
  if (!isIMessageMessageEffectContent(content)) {
    return;
  }
  return content.effect;
};

export const hasIMessageMessageEffect = (content: Content): boolean => {
  if (rawEffect(content) !== undefined) {
    return true;
  }

  if (content.type !== "group") {
    return false;
  }

  for (const item of content.items) {
    const nested = (item as { content?: unknown }).content;
    if (typeof nested !== "object" || nested === null || !("type" in nested)) {
      continue;
    }
    if (hasIMessageMessageEffect(nested as Content)) {
      return true;
    }
  }
  return false;
};

export const stripIMessageMessageEffect = <T extends Content>(
  content: T
): T => {
  if (rawEffect(content) === undefined) {
    return content;
  }
  const {
    __platform: _platform,
    effect: _effect,
    ...rest
  } = content as IMessageMessageEffectContent;
  return rest as T;
};

export function effect(
  input: ContentInput,
  messageEffect: IMessageMessageEffect
): ContentBuilder {
  return {
    build: async () => {
      const content = await resolveContent(input);
      if (!isEffectContent(content)) {
        throw new Error(
          `imessage effect() only supports text and attachment content, got "${content.type}"`
        );
      }
      if (getIMessageMessageEffect(content)) {
        throw new Error(
          "imessage effect() cannot wrap content that already has an effect"
        );
      }
      return {
        ...content,
        __platform: IMESSAGE_PLATFORM,
        effect: assertMessageEffect(messageEffect),
      };
    },
  };
}
