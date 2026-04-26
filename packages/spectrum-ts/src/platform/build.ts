import { resolveContents } from "../content/resolve";
import type { Content, ContentInput } from "../content/types";
import type {
  InboundMessage,
  Message,
  OutboundMessage,
} from "../types/message";
import type { Space } from "../types/space";
import { UnsupportedError } from "../utils/errors";
import type { AnyPlatformDef, ProviderMessageRecord } from "./types";

export type { ProviderMessageRecord } from "./types";

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

const contentPlatform = (content: Content): string | undefined => {
  const platform = (content as { __platform?: unknown }).__platform;
  return typeof platform === "string" ? platform : undefined;
};

const findUnsupportedPlatformContent = (
  content: Content,
  platform: string
): string | undefined => {
  const scopedPlatform = contentPlatform(content);
  if (scopedPlatform && scopedPlatform !== platform) {
    return scopedPlatform;
  }

  if (content.type !== "group") {
    return;
  }

  for (const item of content.items) {
    const nested = (item as { content?: unknown }).content;
    if (typeof nested !== "object" || nested === null || !("type" in nested)) {
      continue;
    }
    const unsupported = findUnsupportedPlatformContent(
      nested as Content,
      platform
    );
    if (unsupported) {
      return unsupported;
    }
  }
};

const unsupportedPlatformContentError = (
  content: Content,
  platform: string
): UnsupportedError | undefined => {
  const requiredPlatform = findUnsupportedPlatformContent(content, platform);
  if (!requiredPlatform) {
    return;
  }
  return UnsupportedError.content(
    content.type,
    platform,
    `requires ${requiredPlatform}`
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
 * its content) into a fully-built `Message`. The same path serves inbound
 * (`events.messages`, `getMessage`) and outbound (`send`, `replyToMessage`)
 * flows — the only difference is `direction`, which decides whether the
 * resulting Message exposes inbound (`react`/`reply`) or outbound (`edit`)
 * affordances. Recursion through `wrapNestedContent` handles reaction targets
 * and group items, which providers return as nested raw records.
 */
export function wrapProviderMessage(
  raw: ProviderMessageRecord,
  ctx: WrapContext,
  direction: "inbound"
): InboundMessage;
export function wrapProviderMessage(
  raw: ProviderMessageRecord,
  ctx: WrapContext,
  direction: "outbound"
): OutboundMessage;
export function wrapProviderMessage(
  raw: ProviderMessageRecord,
  ctx: WrapContext,
  direction: "inbound" | "outbound"
): Message {
  const wrappedContent = wrapNestedContent(raw.content, ctx, direction);
  const base = {
    id: raw.id,
    content: wrappedContent,
    timestamp: raw.timestamp ?? new Date(),
    extras: extractExtras(raw, ctx.definition),
    spaceRef: ctx.spaceRef,
    space: ctx.space,
    definition: ctx.definition,
    client: ctx.client,
    config: ctx.config,
  };
  if (direction === "inbound") {
    if (!raw.sender) {
      throw new Error(
        `Inbound provider message missing sender (platform "${ctx.definition.name}", id "${raw.id}")`
      );
    }
    return buildMessage({ ...base, sender: raw.sender, direction: "inbound" });
  }
  return buildMessage({ ...base, sender: raw.sender, direction: "outbound" });
}

const wrapNestedContent = (
  content: Content,
  ctx: WrapContext,
  direction: "inbound" | "outbound"
): Content => {
  if (content.type === "reaction") {
    const target = content.target as unknown;
    if (isRawProviderRecord(target)) {
      // Reaction targets are always wrapped as "inbound": the target refers to
      // the original received message, not the reaction event itself. So even
      // when the wrapping reaction is outbound (e.g. our own reaction sent via
      // `reactToMessage`), the *target* it points at is a message we received.
      // This differs from `group.items`, which propagate the wrapping
      // direction because each item is itself one piece of the same send.
      return {
        ...content,
        target: wrapProviderMessage(target, ctx, "inbound"),
      };
    }
    return content;
  }
  if (content.type === "group") {
    const items = content.items.map((item) => {
      const raw = item as unknown;
      if (!isRawProviderRecord(raw)) {
        return item;
      }
      return direction === "inbound"
        ? wrapProviderMessage(raw, ctx, "inbound")
        : wrapProviderMessage(raw, ctx, "outbound");
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
    let raw: ProviderMessageRecord | undefined;
    try {
      const platformError = unsupportedPlatformContentError(
        item,
        definition.name
      );
      if (platformError) {
        throw platformError;
      }
      raw = (await definition.actions.send({
        ...typingCtx,
        content: item,
      })) as ProviderMessageRecord | undefined;
    } catch (err) {
      if (err instanceof UnsupportedError) {
        warnUnsupported(err, definition.name);
        return;
      }
      throw err;
    }
    if (!raw?.id) {
      throw new Error(
        `Platform "${definition.name}" send did not return a message id`
      );
    }
    return wrapProviderMessage(
      raw,
      { client, config, definition, space, spaceRef },
      "outbound"
    );
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
    return wrapProviderMessage(
      raw,
      { client, config, definition, space, spaceRef },
      "inbound"
    );
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
    let raw: ProviderMessageRecord | undefined;
    try {
      const platformError = unsupportedPlatformContentError(
        item,
        definition.name
      );
      if (platformError) {
        throw platformError;
      }
      raw = (await replyToMessage({
        space: spaceRef,
        messageId: params.id,
        target,
        content: item,
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
    if (!raw?.id) {
      throw new Error(
        `Platform "${definition.name}" reply did not return a message id`
      );
    }
    return wrapProviderMessage(
      raw,
      { client, config, definition, space, spaceRef },
      "outbound"
    );
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
        const platformError = unsupportedPlatformContentError(
          resolved,
          definition.name
        );
        if (platformError) {
          warnUnsupported(platformError, definition.name);
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
