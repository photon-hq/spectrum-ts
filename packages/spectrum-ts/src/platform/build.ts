import { resolveContents } from "../content/resolve";
import type { Content, ContentInput } from "../content/types";
import type {
  InboundMessage,
  Message,
  OutboundMessage,
} from "../types/message";
import type { Space } from "../types/space";
import type { AnyPlatformDef, SendResult } from "./types";

export type SpaceRef = {
  id: string;
  __platform: string;
} & Record<string, unknown>;

interface BaseBuildParams {
  client: unknown;
  config: unknown;
  content: Content;
  definition: AnyPlatformDef;
  extras: Record<string, unknown>;
  id: string;
  space: Space;
  spaceRef: SpaceRef;
  timestamp: Date;
}

type BuildInboundParams = BaseBuildParams & {
  direction: "inbound";
  sender: { id: string } & Record<string, unknown>;
};

type BuildOutboundParams = BaseBuildParams & {
  direction: "outbound";
  sender: ({ id: string } & Record<string, unknown>) | undefined;
};

export type BuildMessageParams = BuildInboundParams | BuildOutboundParams;

export interface BuildSpaceParams {
  client: unknown;
  config: unknown;
  definition: AnyPlatformDef;
  extras: Record<string, unknown>;
  spaceRef: SpaceRef;
  typingCtx: { space: SpaceRef; client: unknown; config: unknown };
}

export function buildSpace(params: BuildSpaceParams): Space {
  const { spaceRef, extras, typingCtx, definition, client, config } = params;
  // Declared first so inner arrows can reference it after assignment.
  let space: Space;

  async function sendImpl(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage | OutboundMessage[]> {
    const resolved = await resolveContents(content);
    const results: OutboundMessage[] = [];
    for (const item of resolved) {
      const sendResult = (await definition.actions.send({
        ...typingCtx,
        content: item,
      })) as SendResult | undefined;
      if (!sendResult?.id) {
        throw new Error(
          `Platform "${definition.name}" send did not return a message id`
        );
      }
      results.push(
        buildMessage({
          id: sendResult.id,
          content: item,
          sender: sendResult.sender,
          timestamp: sendResult.timestamp ?? new Date(),
          extras: {},
          spaceRef,
          space,
          definition,
          client,
          config,
          direction: "outbound",
        })
      );
    }
    return content.length === 1 && results[0] ? results[0] : results;
  }

  space = {
    ...extras,
    ...spaceRef,
    send: sendImpl as Space["send"],
    edit: async (
      message: OutboundMessage,
      newContent: ContentInput
    ): Promise<void> => {
      await message.edit(newContent);
    },
    startTyping: async () => {
      await definition.actions.startTyping?.(typingCtx);
    },
    stopTyping: async () => {
      await definition.actions.stopTyping?.(typingCtx);
    },
    responding: async <T>(fn: () => T | Promise<T>): Promise<T> => {
      await definition.actions.startTyping?.(typingCtx);
      try {
        return await fn();
      } finally {
        await definition.actions.stopTyping?.(typingCtx).catch(() => {});
      }
    },
  };
  return space;
}

export function buildMessage(params: BuildInboundParams): InboundMessage;
export function buildMessage(params: BuildOutboundParams): OutboundMessage;
export function buildMessage(params: BuildMessageParams): Message {
  const { definition, client, config, spaceRef, space } = params;

  const react = async (reaction: string): Promise<void> => {
    if (!definition.actions.reactToMessage) {
      return;
    }
    await definition.actions.reactToMessage({
      space: spaceRef,
      messageId: params.id,
      reaction,
      client,
      config,
    });
  };

  async function reply(content: ContentInput): Promise<OutboundMessage>;
  async function reply(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage[]>;
  async function reply(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage | OutboundMessage[]> {
    if (!definition.actions.replyToMessage) {
      throw new Error(
        `Platform "${definition.name}" does not support replying to messages`
      );
    }
    const resolved = await resolveContents(content);
    const results: OutboundMessage[] = [];
    for (const item of resolved) {
      const sendResult = (await definition.actions.replyToMessage({
        space: spaceRef,
        messageId: params.id,
        content: item,
        client,
        config,
      })) as SendResult | undefined;
      if (!sendResult?.id) {
        throw new Error(
          `Platform "${definition.name}" reply did not return a message id`
        );
      }
      results.push(
        buildMessage({
          id: sendResult.id,
          content: item,
          sender: sendResult.sender,
          timestamp: sendResult.timestamp ?? new Date(),
          extras: {},
          spaceRef,
          space,
          definition,
          client,
          config,
          direction: "outbound",
        })
      );
    }
    return content.length === 1 && results[0] ? results[0] : results;
  }

  const senderWithPlatform =
    params.sender === undefined
      ? undefined
      : { ...params.sender, __platform: definition.name };

  if (params.direction === "outbound") {
    return {
      ...params.extras,
      id: params.id,
      content: params.content,
      direction: "outbound",
      platform: definition.name,
      react,
      reply,
      edit: async (newContent: ContentInput): Promise<void> => {
        if (!definition.actions.editMessage) {
          throw new Error(
            `Platform "${definition.name}" does not support editing messages`
          );
        }
        const [resolved] = await resolveContents([newContent]);
        if (!resolved) {
          return;
        }
        await definition.actions.editMessage({
          space: spaceRef,
          messageId: params.id,
          content: resolved,
          client,
          config,
        });
      },
      sender: senderWithPlatform,
      space,
      timestamp: params.timestamp,
    } as OutboundMessage;
  }

  return {
    ...params.extras,
    id: params.id,
    content: params.content,
    direction: "inbound",
    platform: definition.name,
    react,
    reply,
    sender: senderWithPlatform as InboundMessage["sender"],
    space,
    timestamp: params.timestamp,
  } as InboundMessage;
}
