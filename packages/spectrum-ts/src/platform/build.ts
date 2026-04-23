import { resolveContents } from "../content/resolve";
import type { Content, ContentInput } from "../content/types";
import type {
  InboundMessage,
  Message,
  OutboundMessage,
} from "../types/message";
import type { Space } from "../types/space";
import { UnsupportedError } from "../utils/errors";
import type { AnyPlatformDef, SendResult } from "./types";

const ANSI_YELLOW = "\x1b[33m";
const ANSI_RESET = "\x1b[0m";

const supportsAnsiColor = (): boolean => {
  if (typeof process === "undefined") {
    return false;
  }
  if (process.env.NO_COLOR) {
    return false;
  }
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) {
    return force !== "" && force !== "0" && force !== "false";
  }
  return Boolean(process.stderr?.isTTY);
};

const warnUnsupported = (err: UnsupportedError, fallbackPlatform: string) => {
  const platform = err.platform ?? fallbackPlatform;
  const subject =
    err.kind === "content"
      ? `content type "${err.contentType ?? "unknown"}"`
      : `action "${err.action ?? "unknown"}"`;
  const detail = err.detail ? `: ${err.detail}` : "";
  const body = `[spectrum-ts] ${platform} does not support ${subject}${detail}; skipping.`;
  console.warn(
    supportsAnsiColor() ? `${ANSI_YELLOW}${body}${ANSI_RESET}` : body
  );
};

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

  async function dispatchReaction(
    item: Extract<Content, { type: "reaction" }>
  ): Promise<void> {
    try {
      if (!definition.actions.reactToMessage) {
        throw UnsupportedError.action("react", definition.name);
      }
      await definition.actions.reactToMessage({
        space: spaceRef,
        messageId: item.target,
        reaction: item.emoji,
        client,
        config,
      });
    } catch (err) {
      if (err instanceof UnsupportedError) {
        warnUnsupported(err, definition.name);
        return;
      }
      throw err;
    }
  }

  async function dispatchSend(
    item: Exclude<Content, { type: "reaction" }>
  ): Promise<OutboundMessage | undefined> {
    let sendResult: SendResult | undefined;
    try {
      sendResult = (await definition.actions.send({
        ...typingCtx,
        content: item,
      })) as SendResult | undefined;
    } catch (err) {
      if (err instanceof UnsupportedError) {
        warnUnsupported(err, definition.name);
        return;
      }
      throw err;
    }
    if (!sendResult?.id) {
      throw new Error(
        `Platform "${definition.name}" send did not return a message id`
      );
    }
    return buildMessage({
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
    });
  }

  async function sendImpl(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage | OutboundMessage[] | undefined> {
    const resolved = await resolveContents(content);
    const results: OutboundMessage[] = [];
    for (const item of resolved) {
      if (item.type === "reaction") {
        await dispatchReaction(item);
        continue;
      }
      const sent = await dispatchSend(item);
      if (sent) {
        results.push(sent);
      }
    }
    if (content.length === 1) {
      return results[0];
    }
    return results;
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
      warnUnsupported(
        UnsupportedError.action("react", definition.name),
        definition.name
      );
      return;
    }
    try {
      await definition.actions.reactToMessage({
        space: spaceRef,
        messageId: params.id,
        reaction,
        client,
        config,
      });
    } catch (err) {
      if (err instanceof UnsupportedError) {
        warnUnsupported(err, definition.name);
        return;
      }
      throw err;
    }
  };

  async function reply(
    content: ContentInput
  ): Promise<OutboundMessage | undefined>;
  async function reply(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage[]>;
  async function reply(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage | OutboundMessage[] | undefined> {
    if (!definition.actions.replyToMessage) {
      warnUnsupported(
        UnsupportedError.action("reply", definition.name),
        definition.name
      );
      return content.length === 1 ? undefined : [];
    }
    const resolved = await resolveContents(content);
    const results: OutboundMessage[] = [];
    for (const item of resolved) {
      let sendResult: SendResult | undefined;
      try {
        sendResult = (await definition.actions.replyToMessage({
          space: spaceRef,
          messageId: params.id,
          content: item,
          client,
          config,
        })) as SendResult | undefined;
      } catch (err) {
        if (err instanceof UnsupportedError) {
          warnUnsupported(err, definition.name);
          continue;
        }
        throw err;
      }
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
    if (content.length === 1) {
      return results[0];
    }
    return results;
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
          warnUnsupported(
            UnsupportedError.action("edit", definition.name),
            definition.name
          );
          return;
        }
        const [resolved] = await resolveContents([newContent]);
        if (!resolved) {
          return;
        }
        try {
          await definition.actions.editMessage({
            space: spaceRef,
            messageId: params.id,
            content: resolved,
            client,
            config,
          });
        } catch (err) {
          if (err instanceof UnsupportedError) {
            warnUnsupported(err, definition.name);
            return;
          }
          throw err;
        }
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
