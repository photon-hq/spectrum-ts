import { edit as editContent } from "../content/edit";
import { reaction as reactionContent } from "../content/reaction";
import { reply as replyContent } from "../content/reply";
import { resolveContents } from "../content/resolve";
import type { Content, ContentInput } from "../content/types";
import { typing as typingContent } from "../content/typing";
import type {
  InboundMessage,
  Message,
  OutboundMessage,
} from "../types/message";
import type { Space } from "../types/space";
import { UnsupportedError } from "../utils/errors";
import type { Store } from "../utils/store";
import type { AnyPlatformDef, ProviderMessageRecord } from "./types";

export type { ProviderMessageRecord } from "./types";

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

  if (content.type === "reply" || content.type === "edit") {
    return findUnsupportedPlatformContent(content.content, platform);
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
  store: Store;
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
  // Pre-built context object passed to `definition.send`. Sites that dispatch
  // through the send pipeline spread this and add per-call fields (e.g.
  // `content`).
  actionCtx: {
    space: SpaceRef;
    client: unknown;
    config: unknown;
    store: Store;
  };
  client: unknown;
  config: unknown;
  definition: AnyPlatformDef;
  extras: Record<string, unknown>;
  spaceRef: SpaceRef;
  store: Store;
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
  store: Store;
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
 * (`messages`, `actions.getMessage`) and outbound (`send`) flows — the only
 * difference is `direction`, which decides whether the resulting Message
 * exposes inbound (`react`/`reply`) or outbound (`edit`) affordances.
 * Recursion through `wrapNestedContent` handles reaction targets and group
 * items, which providers return as nested raw records.
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
    store: ctx.store,
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
      // `space.send(reaction(...))`), the *target* it points at is a message
      // we received. This differs from `group.items`, which propagate the
      // wrapping direction because each item is itself one piece of the same
      // send.
      return {
        ...content,
        target: wrapProviderMessage(target, ctx, "inbound"),
      };
    }
    return content;
  }
  if (content.type === "edit") {
    const target = content.target as unknown;
    if (isRawProviderRecord(target)) {
      // The target of an edit is always one of *our* outbound messages —
      // the message being rewritten. Wrap as outbound so its `.edit`
      // affordance is available downstream. Defensive parity with the
      // reaction branch above; in practice providers return `undefined`
      // from `send` for edits, so this rarely fires.
      return {
        ...content,
        target: wrapProviderMessage(target, ctx, "outbound"),
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
  const { spaceRef, extras, actionCtx, definition, client, config, store } =
    params;
  // Declared first so inner arrows can reference it after assignment.
  let space: Space;

  async function dispatchSend(
    item: Content
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
      raw = (await definition.send({
        ...actionCtx,
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
      // Reactions, typing indicators, and edits are fire-and-forget control
      // signals — providers may return `void` from `send` for them. Every
      // other content type must produce a message id.
      if (
        item.type === "reaction" ||
        item.type === "typing" ||
        item.type === "edit"
      ) {
        return;
      }
      throw new Error(
        `Platform "${definition.name}" send did not return a message id`
      );
    }
    return wrapProviderMessage(
      raw,
      { client, config, definition, space, spaceRef, store },
      "outbound"
    );
  }

  async function sendImpl(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<OutboundMessage | OutboundMessage[] | undefined> {
    const resolved = await resolveContents(content);
    const results: OutboundMessage[] = [];
    for (const item of resolved) {
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
    const getMessage = definition.actions?.getMessage;
    if (!getMessage) {
      warnUnsupported(
        UnsupportedError.action("getMessage", definition.name),
        definition.name
      );
      return;
    }
    let raw: ProviderMessageRecord | undefined;
    try {
      raw = (await getMessage({
        space: spaceRef,
        messageId: id,
        client,
        config,
        store,
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
      { client, config, definition, space, spaceRef, store },
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
      // Sugar for `space.send(edit(newContent, message))`. Edits are
      // fire-and-forget; the (always-undefined) result is discarded.
      await space.send(editContent(newContent, message));
    },
    getMessage: getMessageImpl,
    startTyping: async () => {
      // Sugar for `space.send(typing("start"))`. Typing is fire-and-forget;
      // providers handle it inside their `send` action and any platforms
      // without a typing API silently no-op.
      await space.send(typingContent("start"));
    },
    stopTyping: async () => {
      await space.send(typingContent("stop"));
    },
    responding: async <T>(fn: () => T | Promise<T>): Promise<T> => {
      await space.send(typingContent("start"));
      try {
        return await fn();
      } finally {
        await space.send(typingContent("stop")).catch(() => {});
      }
    },
  };
  return space;
}

export function buildMessage(params: BuildInboundParams): InboundMessage;
export function buildMessage(params: BuildOutboundParams): OutboundMessage;
export function buildMessage(params: BuildMessageParams): Message {
  const { definition, space } = params;

  // Late-bound self reference so `react()` can pass the built Message as the
  // reaction target.
  let self: Message | undefined;

  const react = async (emoji: string): Promise<void> => {
    const target = requireBuiltMessage("react");
    // Sugar for `space.send(reaction(emoji, target))`. The canonical form
    // returns `OutboundMessage | undefined`; this surface discards it because
    // reactions are fire-and-forget on most platforms (callers reach for the
    // canonical form when they need the result).
    await space.send(reactionContent(emoji, target));
  };

  const requireBuiltMessage = (action: "react" | "reply" | "edit"): Message => {
    if (!self) {
      throw new Error(
        `${action}() called before message construction completed (internal bug)`
      );
    }
    return self;
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
    const target = requireBuiltMessage("reply");
    const wrapped = content.map((c) => replyContent(c, target)) as [
      ContentInput,
      ...ContentInput[],
    ];
    // The cast mirrors the existing `sendImpl as Space["send"]` below —
    // overload resolution can't pick the right shape from a generic
    // spread, but the runtime delegates 1:1.
    return (
      space.send as (
        ...c: [ContentInput, ...ContentInput[]]
      ) => Promise<OutboundMessage | OutboundMessage[] | undefined>
    )(...wrapped);
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
        // Sugar for `space.send(edit(newContent, self))`. Unsupported-content
        // checks, fire-and-forget dispatch, and provider delegation all flow
        // through the canonical send pipeline.
        const target = requireBuiltMessage("edit") as OutboundMessage;
        await space.send(editContent(newContent, target));
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
