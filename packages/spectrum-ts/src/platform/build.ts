import { createLogger, withSpan } from "@photon-ai/otel";
import { type AvatarInput, avatar as avatarContent } from "../content/avatar";
import { edit as editContent } from "../content/edit";
import {
  type Reaction,
  reaction as reactionContent,
} from "../content/reaction";
import { rename as renameContent } from "../content/rename";
import { reply as replyContent } from "../content/reply";
import { resolveContents } from "../content/resolve";
import {
  drainStreamText,
  StreamConsumedError,
  type StreamText,
} from "../content/stream-text";
import { asText } from "../content/text";
import type { Content, ContentInput } from "../content/types";
import { typing as typingContent } from "../content/typing";
import { unsend as unsendContent } from "../content/unsend";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import type { AgentSender } from "../types/user";
import { UnsupportedError } from "../utils/errors";
import type { Store } from "../utils/store";
import { contentAttrs } from "../utils/telemetry";
import type {
  AnyPlatformDef,
  PlatformWiseActionKey,
  ProviderMessageRecord,
} from "./types";

const platformLog = createLogger("spectrum.platform");

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

// Built-in content types whose provider `send` may return `void`/no id
// because they're side-effects (typing indicator, edit, unsend), not new
// messages. Reactions are NOT fire-and-forget: providers must return a
// record so the caller gets a reaction Message back as an unsend handle.
// Provider-only content types opt into fire-and-forget semantics by setting
// `__fireAndForget: true` on the content value — see `isFireAndForget`
// below — so the framework doesn't need to know their `type` literal.
const FIRE_AND_FORGET_TYPES: ReadonlySet<string> = new Set([
  "typing",
  "edit",
  "rename",
  "avatar",
  "unsend",
]);

const isFireAndForget = (item: Content): boolean =>
  FIRE_AND_FORGET_TYPES.has(item.type) ||
  (item as { __fireAndForget?: unknown }).__fireAndForget === true;

// Reserved keys on `Space` — platform-defined `space.actions` entries with
// these names are skipped at runtime (with a warning) so the universal sugar
// (`send`, `edit`, `startTyping`, …) always wins. The same names are excluded
// from `SpaceActionMethods<Def>` at the type level.
const RESERVED_SPACE_KEYS: ReadonlySet<string> = new Set([
  "__platform",
  "id",
  "send",
  "edit",
  "unsend",
  "getMessage",
  "rename",
  "avatar",
  "startTyping",
  "stopTyping",
  "responding",
]);

// Framework-known action keys with default behavior. Used by `define.ts` to
// distinguish platform-wise overrides from platform-specific extensions, and
// to wire the same set onto every `PlatformInstance` regardless of override
// status. The runtime list must stay in sync with `PlatformWiseActions` in
// `types.ts` — the typed `satisfies` here catches typos at the element level.
export const PLATFORM_WISE_ACTION_KEYS: ReadonlySet<PlatformWiseActionKey> =
  new Set(["getMessage"] satisfies readonly PlatformWiseActionKey[]);

// Reserved keys on `Message` — platform-defined `message.actions` entries
// with these names are skipped at runtime (with a warning) so the universal
// sugar (`react`, `reply`, `edit`, …) always wins. The same names are
// excluded from `MessageActionMethods<Def>` at the type level.
const RESERVED_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  "content",
  "direction",
  "edit",
  "id",
  "platform",
  "react",
  "reply",
  "sender",
  "space",
  "timestamp",
  "unsend",
]);

const scopeLabel = (scope: "space" | "message" | "instance"): string => {
  if (scope === "space") {
    return "Space";
  }
  if (scope === "message") {
    return "Message";
  }
  return "PlatformInstance";
};

export const warnReservedAction = (
  scope: "space" | "message" | "instance",
  name: string,
  platform: string
) => {
  const body = `[spectrum-ts] ${platform} declared ${scope} action "${name}" which collides with a reserved ${scopeLabel(scope)} key; skipping.`;
  console.warn(
    supportsAnsiColor() ? `${ANSI_YELLOW}${body}${ANSI_RESET}` : body
  );
};

const warnUnsupported = (err: UnsupportedError, fallbackPlatform: string) => {
  const platform = err.platform ?? fallbackPlatform;
  const subject =
    err.kind === "content"
      ? `content type "${err.contentType ?? "unknown"}"`
      : `action "${err.action ?? "unknown"}"`;
  const detail = err.detail ? `: ${err.detail}` : "";
  platformLog.warn(
    `${platform} does not support ${subject}${detail}; skipping.`,
    {
      "spectrum.provider": platform,
      "spectrum.unsupported.kind": err.kind,
      "spectrum.unsupported.content_type": err.contentType,
      "spectrum.unsupported.action": err.action,
    }
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

// Locate the stream a send carries, if any. A stream appears either as the
// top-level content or wrapped one level deep in `reply`/`edit` (the only
// wrappers whose inner content can be a `streamText`).
const findStreamText = (item: Content): StreamText | undefined => {
  if (item.type === "streamText") {
    return item;
  }
  if (
    (item.type === "reply" || item.type === "edit") &&
    item.content.type === "streamText"
  ) {
    return item.content;
  }
  return;
};

// Rewrite a stream-bearing content as plain text, preserving a `reply`/`edit`
// wrapper so the fallback send keeps its target.
const replaceStreamText = (item: Content, full: string): Content => {
  const text = asText(full);
  if (item.type === "reply" || item.type === "edit") {
    return { ...item, content: text };
  }
  return text;
};

type ProviderSend = (
  content: Content
) => Promise<ProviderMessageRecord | undefined>;

/**
 * Dispatch `content` to the provider, falling back to plain text on platforms
 * that can't stream. When the provider rejects a stream-bearing send with
 * `UnsupportedError`, wait for the stream to finish and re-send the
 * accumulated text as `text` content (preserving a `reply`/`edit` wrapper) —
 * so `streamText` works everywhere, just without live updates. Rethrows the
 * original error when no fallback applies (non-stream content, a stream that
 * produced no text, or a stream the provider already consumed — e.g. a native
 * driver that streamed and then failed); an `UnsupportedError` from the
 * fallback send itself propagates too. Both land in the caller's warn-and-skip
 * handling.
 */
async function sendWithStreamTextFallback(
  send: ProviderSend,
  item: Content,
  platform: string
): Promise<ProviderMessageRecord | undefined> {
  try {
    return await send(item);
  } catch (err) {
    if (!(err instanceof UnsupportedError)) {
      throw err;
    }
    const source = findStreamText(item);
    if (!source) {
      throw err;
    }
    platformLog.info(
      `${platform} does not support streaming text; waiting for the stream to finish to send the full text as one message.`,
      {
        "spectrum.provider": platform,
        "spectrum.stream_text.fallback": true,
      }
    );
    let full: string;
    try {
      full = await drainStreamText(source);
    } catch (drainErr) {
      if (drainErr instanceof StreamConsumedError) {
        // The provider already consumed the stream (a native driver streamed
        // it and then failed) — re-draining is impossible, so surface the
        // original UnsupportedError rather than the consumed-stream error.
        throw err;
      }
      // A genuine stream failure mid-drain propagates as-is.
      throw drainErr;
    }
    if (!full) {
      // The stream ended without any text — nothing to send.
      throw err;
    }
    return await send(replaceStreamText(item, full));
  }
}

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
  // Optional: inbound system signals (typing indicators, reactions with no
  // `from_handle`) carry no attributable author. buildMessage maps a missing
  // sender to `undefined` on the resulting Message (whose `sender` is `| undefined`).
  sender: ({ id: string } & Record<string, unknown>) | undefined;
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
  // `sender` may be absent for inbound system signals that carry no attributable
  // author — e.g. typing indicators, or reactions without a `from_handle`.
  // `Message.sender` is `| undefined` and `buildMessage` maps a missing sender to
  // `undefined`, so senderless inbound is allowed rather than rejected. The
  // branch keeps `direction` a literal so it narrows BuildMessageParams.
  if (direction === "inbound") {
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
  ): Promise<Message<string, AgentSender> | undefined> {
    return withSpan(
      "spectrum.message.send",
      {
        "spectrum.provider": definition.name,
        "spectrum.space.id": (spaceRef as { id?: string }).id,
        "spectrum.message.fire_and_forget": isFireAndForget(item),
        ...contentAttrs(item),
      },
      async () => {
        const platformError = unsupportedPlatformContentError(
          item,
          definition.name
        );
        if (platformError) {
          warnUnsupported(platformError, definition.name);
          return;
        }
        const providerSend: ProviderSend = async (content) =>
          (await definition.send({
            ...actionCtx,
            content,
          })) as ProviderMessageRecord | undefined;
        let raw: ProviderMessageRecord | undefined;
        try {
          raw = await sendWithStreamTextFallback(
            providerSend,
            item,
            definition.name
          );
        } catch (err) {
          if (err instanceof UnsupportedError) {
            warnUnsupported(err, definition.name);
            return;
          }
          throw err;
        }
        if (!raw?.id) {
          // Typing indicators and edits are fire-and-forget control signals —
          // providers may return `void` from `send` for them. Every other
          // content type (including reactions) must produce a message id.
          if (isFireAndForget(item)) {
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
        ) as Message<string, AgentSender>;
      }
    );
  }

  async function sendImpl(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<
    Message<string, AgentSender> | Message<string, AgentSender>[] | undefined
  > {
    const resolved = await resolveContents(content);
    const results: Message<string, AgentSender>[] = [];
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
      // Default behavior when the provider hasn't implemented the
      // platform-wise `getMessage` action: throw `UnsupportedError`. Mirrors
      // the same default the `PlatformInstance` wires for `im.getMessage`.
      throw UnsupportedError.action("getMessage", definition.name);
    }
    return withSpan(
      "spectrum.message.get",
      {
        "spectrum.provider": definition.name,
        "spectrum.space.id": (spaceRef as { id?: string }).id,
        "spectrum.message.id": id,
      },
      async () => {
        const raw = (await getMessage(
          { client, config, store },
          spaceRef,
          id
        )) as ProviderMessageRecord | undefined;
        if (!raw) {
          return;
        }
        return wrapProviderMessage(
          raw,
          { client, config, definition, space, spaceRef, store },
          "inbound"
        );
      }
    );
  }

  // Platform-defined sugar methods declared via `PlatformDef.space.actions`.
  // Each factory becomes `space.<name>(...args) = space.send(factory(...args))`.
  // Spread order is load-bearing: actions go *after* `extras`/`spaceRef`
  // (so schema fields can't clobber the sugar) and *before* the hardcoded
  // universal sugar (`send`, `edit`, …) so a platform action declared with
  // a reserved name is also overridden at the type level via the
  // `Exclude<…, keyof Space>` in `SpaceActionMethods`.
  const platformActions: Record<string, (...args: unknown[]) => Promise<void>> =
    {};
  const declaredActions = (
    definition.space as {
      actions?: Record<
        string,
        (space: Space, ...args: unknown[]) => Promise<void>
      >;
    }
  ).actions;
  if (declaredActions) {
    for (const [name, factory] of Object.entries(declaredActions)) {
      if (RESERVED_SPACE_KEYS.has(name)) {
        warnReservedAction("space", name, definition.name);
        continue;
      }
      platformActions[name] = async (...args: unknown[]) => {
        await factory(space, ...args);
      };
    }
  }

  space = {
    ...extras,
    ...spaceRef,
    ...platformActions,
    send: sendImpl as Space["send"],
    edit: async (
      message: Message | undefined,
      newContent: ContentInput
    ): Promise<void> => {
      // Sugar for `space.send(edit(newContent, message))`. Edits are
      // fire-and-forget; the (always-undefined) result is discarded. The
      // `edit()` content builder enforces `direction === "outbound"` at the
      // top, so invalid targets fail fast here too.
      await space.send(editContent(newContent, message));
    },
    unsend: async (message: Message | undefined): Promise<void> => {
      // Sugar for `space.send(unsend(message))`. Unsends are fire-and-forget;
      // the (always-undefined) result is discarded. The `unsend()` content
      // builder enforces `direction === "outbound"` at the top, so invalid
      // targets fail fast here too.
      await space.send(unsendContent(message));
    },
    getMessage: getMessageImpl,
    rename: async (displayName: string): Promise<void> => {
      // Sugar for `space.send(rename(displayName))`. Fire-and-forget; the
      // (always-undefined) result is discarded. Per-platform support and
      // constraints live in each provider's `send` action.
      await space.send(renameContent(displayName));
    },
    avatar: (async (
      input: AvatarInput,
      options?: { mimeType?: string }
    ): Promise<void> => {
      // Sugar for `space.send(avatar(input, options?))`. Fire-and-forget; the
      // (always-undefined) result is discarded. Per-platform support and
      // constraints live in each provider's `send` action.
      //
      // Branch by input shape so `avatarContent`'s narrow overloads pick the
      // right signature (string | URL vs Buffer + required mimeType) without a
      // cast.
      if (typeof input === "string" || input instanceof URL) {
        await space.send(avatarContent(input, options));
        return;
      }
      if (!options?.mimeType) {
        throw new Error(
          "space.avatar(Buffer) requires options.mimeType — pass { mimeType: '...' }"
        );
      }
      await space.send(avatarContent(input, { mimeType: options.mimeType }));
    }) as Space["avatar"],
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

export function buildMessage(params: BuildMessageParams): Message {
  const { definition, space } = params;

  // Late-bound self reference so `react()` can pass the built Message as the
  // reaction target.
  let self: Message | undefined;

  const requireBuiltMessage = (action: string): Message => {
    if (!self) {
      throw new Error(
        `${action}() called before message construction completed (internal bug)`
      );
    }
    return self;
  };

  const react = async (
    emoji: string
  ): Promise<
    (Message<string, AgentSender> & { content: Reaction }) | undefined
  > => {
    const target = requireBuiltMessage("react");
    // Sugar for `space.send(reaction(emoji, target))`. The resolved Message
    // is the reaction handle a caller keeps to unsend later; `undefined`
    // when the platform doesn't support reactions (UnsupportedError → warn).
    return await space.send(reactionContent(emoji, target));
  };

  async function reply(
    content: ContentInput
  ): Promise<Message<string, AgentSender> | undefined>;
  async function reply(
    ...content: [ContentInput, ContentInput, ...ContentInput[]]
  ): Promise<Message<string, AgentSender>[]>;
  async function reply(
    ...content: [ContentInput, ...ContentInput[]]
  ): Promise<
    Message<string, AgentSender> | Message<string, AgentSender>[] | undefined
  > {
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
      ) => Promise<
        | Message<string, AgentSender>
        | Message<string, AgentSender>[]
        | undefined
      >
    )(...wrapped);
  }

  const edit = async (newContent: ContentInput): Promise<void> => {
    // Defense-in-depth: the `edit()` content builder enforces the same guard
    // before resolution, but checking here gives a clearer call-site stack
    // for the most common misuse (calling `.edit()` on an inbound message).
    const target = requireBuiltMessage("edit");
    if (target.direction !== "outbound") {
      throw new Error(
        `cannot edit message ${target.id}: only outbound messages can be edited (direction: "${target.direction}")`
      );
    }
    await space.send(editContent(newContent, target));
  };

  const unsend = async (): Promise<void> => {
    // Defense-in-depth: the `unsend()` content builder enforces the same
    // guard, but checking here gives a clearer call-site stack for the most
    // common misuse (calling `.unsend()` on an inbound message).
    const target = requireBuiltMessage("unsend");
    if (target.direction !== "outbound") {
      throw new Error(
        `cannot unsend message ${target.id}: only outbound messages can be unsent (direction: "${target.direction}")`
      );
    }
    await space.send(unsendContent(target));
  };

  // Outbound senders are structurally tagged with `kind: "agent"` so the
  // runtime shape matches the `AgentSender` type advertised by `send()`
  // / `reply()` returns. Inbound senders are passed through untouched.
  const buildSenderWithPlatform = ():
    | ({ id: string } & Record<string, unknown>)
    | undefined => {
    if (params.sender === undefined) {
      return;
    }
    if (params.direction === "outbound") {
      return {
        ...params.sender,
        __platform: definition.name,
        kind: "agent" as const,
      };
    }
    return { ...params.sender, __platform: definition.name };
  };
  const senderWithPlatform = buildSenderWithPlatform();

  // Platform-defined sugar methods declared via `PlatformDef.message.actions`.
  // Each factory takes `self` as its first argument; the wrapper supplies
  // `self` lazily (via `requireBuiltMessage`) so it sees the constructed
  // object, then calls `space.send(factory(self, ...args))`. Spread order
  // below mirrors `buildSpace` — actions go *before* the hardcoded universal
  // sugar (`react`, `reply`, `edit`) so a same-named action loses both at
  // runtime and at the type level (via `Exclude<…, keyof Message>`).
  const messagePlatformActions: Record<
    string,
    (...args: unknown[]) => Promise<void>
  > = {};
  const declaredMessageActions = (
    definition.message as
      | {
          actions?: Record<
            string,
            (message: Message, ...args: unknown[]) => Promise<void>
          >;
        }
      | undefined
  )?.actions;
  if (declaredMessageActions) {
    for (const [name, factory] of Object.entries(declaredMessageActions)) {
      if (RESERVED_MESSAGE_KEYS.has(name)) {
        warnReservedAction("message", name, definition.name);
        continue;
      }
      messagePlatformActions[name] = async (...args: unknown[]) => {
        const target = requireBuiltMessage(name);
        await factory(target, ...args);
      };
    }
  }

  const message = {
    ...params.extras,
    ...messagePlatformActions,
    id: params.id,
    content: params.content,
    direction: params.direction,
    platform: definition.name,
    react,
    reply,
    edit,
    unsend,
    sender: senderWithPlatform,
    space,
    timestamp: params.timestamp,
  } as Message;
  self = message;
  return message;
}
