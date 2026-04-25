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

type ReplyToMessageAction = NonNullable<
  AnyPlatformDef["actions"]["replyToMessage"]
>;

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

// Raw provider message fields — everything else on a provider-emitted record
// is platform-specific extras (e.g. `partIndex` for iMessage).
export const providerMessageCoreKeys: ReadonlySet<string> = new Set([
  "content",
  "id",
  "sender",
  "space",
  "timestamp",
]);

export type ProviderMessageRecord = {
  id: string;
  content: Content;
  sender: { id: string } & Record<string, unknown>;
  space: { id: string } & Record<string, unknown>;
  timestamp?: Date;
} & Record<string, unknown>;

export interface WrapContext {
  client: unknown;
  config: unknown;
  definition: AnyPlatformDef;
  space: Space;
  spaceRef: SpaceRef;
}

const extractExtras = (
  raw: ProviderMessageRecord,
  definition: AnyPlatformDef
): Record<string, unknown> => {
  const entries = Object.entries(raw).filter(
    ([key]) => !providerMessageCoreKeys.has(key)
  );
  const extra = Object.fromEntries(entries);
  return (
    definition.message?.schema ? definition.message.schema.parse(extra) : extra
  ) as Record<string, unknown>;
};

/**
 * Wrap a raw provider message record (and any nested raw targets/items inside
 * its content) into a fully-built inbound `Message`. The recursion handles
 * reaction targets and group items, which arrive from providers as raw shapes.
 */
export function wrapProviderMessage(
  raw: ProviderMessageRecord,
  ctx: WrapContext
): InboundMessage {
  const wrappedContent = wrapNestedContent(raw.content, ctx);
  return buildMessage({
    id: raw.id,
    content: wrappedContent,
    sender: raw.sender,
    timestamp: raw.timestamp ?? new Date(),
    extras: extractExtras(raw, ctx.definition),
    spaceRef: ctx.spaceRef,
    space: ctx.space,
    definition: ctx.definition,
    client: ctx.client,
    config: ctx.config,
    direction: "inbound",
  });
}

const wrapNestedContent = (content: Content, ctx: WrapContext): Content => {
  if (content.type === "reaction") {
    const target = content.target as unknown;
    if (isRawProviderRecord(target)) {
      return {
        ...content,
        target: wrapProviderMessage(target, ctx),
      };
    }
    return content;
  }
  if (content.type === "group") {
    const items = content.items.map((item) => {
      const raw = item as unknown;
      return isRawProviderRecord(raw) ? wrapProviderMessage(raw, ctx) : item;
    });
    return { ...content, items };
  }
  return content;
};

const isRawProviderRecord = (v: unknown): v is ProviderMessageRecord => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const record = v as Record<string, unknown>;
  // A built Message has `react` and `reply` methods; a raw provider record
  // does not. We use that to distinguish the two when they both satisfy the
  // `isMessage` guard used by Zod custom validators.
  return (
    "id" in record &&
    "content" in record &&
    typeof record.react !== "function" &&
    typeof record.reply !== "function"
  );
};

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
        target: item.target,
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

    // If the provider reported per-item send receipts for a group, replace
    // the placeholder items (produced by the `group()` builder, which cannot
    // know ids before the send) with real outbound Messages carrying each
    // native receipt. This is what lets consumers call
    // `outMsg.content.items[i].react(...)` after a group send.
    const outboundContent =
      item.type === "group" && sendResult.groupMembers
        ? {
            ...item,
            items: item.items.map((stub, idx) => {
              const member = sendResult?.groupMembers?.[idx];
              if (!member?.id) {
                return stub;
              }
              return buildMessage({
                id: member.id,
                content: stub.content,
                sender: member.sender,
                timestamp: member.timestamp ?? new Date(),
                extras: {},
                spaceRef,
                space,
                definition,
                client,
                config,
                direction: "outbound",
              });
            }),
          }
        : item;

    return buildMessage({
      id: sendResult.id,
      content: outboundContent,
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

  async function getMessageImpl(id: string): Promise<Message | undefined> {
    if (!definition.actions.getMessage) {
      warnUnsupported(
        UnsupportedError.action("getMessage", definition.name),
        definition.name
      );
      return;
    }
    let raw: ProviderMessageRecord | undefined;
    try {
      raw = (await definition.actions.getMessage({
        space: spaceRef,
        messageId: id,
        client,
        config,
      })) as ProviderMessageRecord | undefined;
    } catch (err) {
      if (err instanceof UnsupportedError) {
        warnUnsupported(err, definition.name);
        return;
      }
      throw err;
    }
    if (!raw) {
      return;
    }
    return wrapProviderMessage(raw, {
      client,
      config,
      definition,
      space,
      spaceRef,
    });
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
    getMessage: getMessageImpl,
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

  // Late-bound self reference so `react()` can pass the built Message as the
  // reaction target.
  let self: Message | undefined;

  const react = async (reaction: string): Promise<void> => {
    if (!definition.actions.reactToMessage) {
      warnUnsupported(
        UnsupportedError.action("react", definition.name),
        definition.name
      );
      return;
    }
    if (!self) {
      throw new Error(
        "react() called before message construction completed (internal bug)"
      );
    }
    try {
      await definition.actions.reactToMessage({
        space: spaceRef,
        target: self,
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

  const requireBuiltMessage = (action: "react" | "reply"): Message => {
    if (!self) {
      throw new Error(
        `${action}() called before message construction completed (internal bug)`
      );
    }
    return self;
  };

  const dispatchReplyItem = async (
    item: Content,
    target: Message,
    replyToMessage: ReplyToMessageAction
  ): Promise<OutboundMessage | undefined> => {
    let sendResult: SendResult | undefined;
    try {
      sendResult = (await replyToMessage({
        space: spaceRef,
        messageId: params.id,
        target,
        content: item,
        client,
        config,
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
        `Platform "${definition.name}" reply did not return a message id`
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
    const replyToMessage = definition.actions.replyToMessage;
    if (!replyToMessage) {
      warnUnsupported(
        UnsupportedError.action("reply", definition.name),
        definition.name
      );
      return content.length === 1 ? undefined : [];
    }
    const resolved = await resolveContents(content);
    const target = requireBuiltMessage("reply");
    const results: OutboundMessage[] = [];
    for (const item of resolved) {
      const sent = await dispatchReplyItem(item, target, replyToMessage);
      if (sent) {
        results.push(sent);
      }
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
    const outbound = {
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
    self = outbound;
    return outbound;
  }

  const inbound = {
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
  self = inbound;
  return inbound;
}
