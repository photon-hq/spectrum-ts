import type { Fn, Pipe, Tuples } from "hotscript";
import type z from "zod";
import type { Content, ContentBuilder } from "../content/types";
import type {
  InboundMessage,
  Message,
  OutboundMessage,
} from "../types/message";
import type { Space } from "../types/space";
import type { User } from "../types/user";
import type { Store } from "../utils/store";
import type { ManagedStream } from "../utils/stream";

/**
 * A platform-defined sugar method on `Space`. Each entry is a content-builder
 * factory; the runtime injects a thin wrapper that calls
 * `space.send(factory(...args))` and returns the result.
 *
 * Names that collide with reserved `Space` keys (`send`, `edit`,
 * `getMessage`, `startTyping`, `stopTyping`, `responding`, `id`,
 * `__platform`) are skipped at runtime with a warning and excluded at the
 * type level via `Exclude<…, keyof Space>`.
 */
export type SpaceActionFactory = (...args: never[]) => ContentBuilder;

/**
 * A platform-defined sugar method on `Message`. The first parameter is bound
 * to the message itself (`self`) at build time, so callers only pass the
 * trailing args. The runtime injects a thin wrapper that calls
 * `space.send(factory(self, ...args))` — actions are fire-and-forget and
 * return `Promise<void>`.
 *
 * Names that collide with reserved `Message` keys (`react`, `reply`, `edit`,
 * `id`, `space`, `sender`, `content`, `platform`, `direction`, `timestamp`)
 * are skipped at runtime with a warning and excluded at the type level via
 * `Exclude<…, keyof Message>`.
 */
export type MessageActionFactory = (
  message: Message,
  ...args: never[]
) => ContentBuilder;

type ResolvedSpace = Pick<Space, "id">;
type SpaceRef = Pick<Space, "id" | "__platform">;
type ResolvedUser = Pick<User, "id">;
type AwaitedReturn<T> = T extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;
type NoInferClient<T> = [T][T extends unknown ? 0 : never];
type SchemaInfer<T> = T extends { schema?: infer S extends z.ZodType<object> }
  ? z.infer<S>
  : Record<never, never>;
type InferSchema<TSchema> =
  TSchema extends z.ZodType<object> ? z.infer<TSchema> : Record<never, never>;
type InferOptionalSchema<TSchema> =
  TSchema extends z.ZodType<object> ? z.infer<TSchema> : never;

type InputSchema<TSchema> =
  TSchema extends z.ZodType<object> ? z.input<TSchema> : never;

// ---------------------------------------------------------------------------
// Event system types
// ---------------------------------------------------------------------------

export type EventProducer<
  TPayload = unknown,
  TClient = unknown,
  TConfig = unknown,
> = (ctx: {
  client: NoInferClient<TClient>;
  config: TConfig;
  store: Store;
}) => AsyncIterable<TPayload>;

export type ProviderMessage<
  TSender extends ResolvedUser = ResolvedUser,
  TSpace extends ResolvedSpace = ResolvedSpace,
  TExtra extends object = Record<never, never>,
> = {
  id: string;
  content: Content;
  sender: TSender;
  space: TSpace;
  timestamp?: Date;
} & TExtra;

/**
 * A message a provider produced — used for both inbound (`messages`,
 * `actions.getMessage`) and outbound (`send`) flows. Providers return their native
 * record shape (including platform extras like `partIndex`/`parentId` for
 * iMessage) and the platform `wrapProviderMessage` pipeline turns it into a
 * fully-built Message.
 *
 * `sender` is optional because outbound sends often can't synthesize one
 * (the SDK doesn't surface the bot's own handle); inbound providers are
 * expected to populate it.
 */
export type ProviderMessageRecord = {
  id: string;
  content: Content;
  sender?: { id: string } & Record<string, unknown>;
  space: { id: string } & Record<string, unknown>;
  timestamp?: Date;
} & Record<string, unknown>;

type MergeSchema<
  TSchema extends z.ZodType | undefined,
  TBase extends object,
> = TSchema extends z.ZodType
  ? string extends keyof z.infer<TSchema>
    ? TBase
    : Omit<z.infer<TSchema>, keyof TBase> & TBase
  : TBase;

export type SchemaMessage<
  TUserSchema extends z.ZodType | undefined = undefined,
  TSpaceSchema extends z.ZodType | undefined = undefined,
> = ProviderMessage<
  MergeSchema<TUserSchema, ResolvedUser>,
  MergeSchema<TSpaceSchema, ResolvedSpace>
>;

type InferEventPayload<T> = T extends (ctx: never) => AsyncIterable<infer P>
  ? P
  : never;

// ---------------------------------------------------------------------------
// Reserved names — event names that would collide with SpectrumInstance methods
// ---------------------------------------------------------------------------

type ReservedNames = "stop" | "send" | "__internal" | "__providers";

// ---------------------------------------------------------------------------
// PlatformDef — the full definition of a platform adapter
// ---------------------------------------------------------------------------

export interface CreateClientContext<_ConfigSchema extends z.ZodType<object>> {
  config: z.infer<_ConfigSchema>;
  projectId: string | undefined;
  projectSecret: string | undefined;
  store: Store;
}

/**
 * The full definition of a platform adapter.
 *
 * Spectrum's platform API is shaped around the universal messaging contract:
 * **`messages` (inbound stream) + `send` (outbound dispatcher)**. Together
 * they handle 99% of what any platform integration needs to do — every
 * higher-level affordance (`message.reply`, `message.react`, `space.edit`,
 * `space.startTyping`, etc.) is sugar that routes through `send`.
 *
 * Everything beyond those two is optional: `getMessage` is a known capability
 * that lives inside `actions?`; platform-specific event streams live inside
 * `events?` and surface as flat properties on the platform instance.
 *
 * Minimum viable platform integration:
 * `name`, `config`, `lifecycle`, `user`, `space`, `messages`, `send`.
 */
export interface PlatformDef<
  _Name extends string = string,
  _ConfigSchema extends z.ZodType<object> = z.ZodType<object>,
  _UserSchema extends z.ZodType<object> | undefined = undefined,
  _SpaceSchema extends z.ZodType<object> | undefined = undefined,
  _SpaceParamsSchema extends z.ZodType<object> | undefined = undefined,
  _Client = unknown,
  _ResolvedUser extends ResolvedUser = ResolvedUser,
  _ResolvedSpace extends ResolvedSpace = ResolvedSpace,
  _MessageSchema extends z.ZodType<object> | undefined = undefined,
  _MessageType extends ProviderMessage<
    _ResolvedUser,
    _ResolvedSpace,
    InferSchema<_MessageSchema>
  > = ProviderMessage<
    _ResolvedUser,
    _ResolvedSpace,
    InferSchema<_MessageSchema>
  >,
  _Events extends
    | (Record<
        string,
        EventProducer<unknown, _Client, z.infer<_ConfigSchema>>
      > & { messages?: never })
    | undefined = undefined,
  _SpaceActions extends Record<string, SpaceActionFactory> = Record<
    never,
    never
  >,
  _MessageActions extends Record<string, MessageActionFactory> = Record<
    never,
    never
  >,
> {
  /**
   * Optional escape hatch: platform actions beyond `send`. Currently the
   * framework recognizes one slot:
   *
   * - **`getMessage?`** — fetch a message by id from a space. Powers
   *   `space.getMessage(id)`. When omitted, `space.getMessage()` warns and
   *   returns `undefined`.
   *
   * 99% of integrations don't need this — `messages` + `send` is the
   * universal contract.
   */
  actions?: {
    getMessage?: (_: {
      space: _ResolvedSpace & SpaceRef;
      messageId: string;
      client: NoInferClient<_Client>;
      config: z.infer<_ConfigSchema>;
      store: Store;
    }) => Promise<_MessageType | undefined>;
  };

  config: _ConfigSchema;

  /**
   * Optional escape hatch: platform-specific event streams beyond the core
   * `messages` stream (e.g. presence updates, read receipts). Each producer
   * is surfaced as a flat property on both `spectrum` and the platform
   * instance (e.g. `spectrum.presence`, `slack.readReceipt`).
   *
   * The key `messages` is reserved — the core inbound stream lives at the
   * top level, not inside `events?`.
   *
   * 99% of integrations don't need this — `messages` + `send` is the
   * universal contract.
   */
  events?: _Events;

  lifecycle: {
    createClient: (ctx: CreateClientContext<_ConfigSchema>) => Promise<_Client>;
    destroyClient?: (ctx: {
      client: NoInferClient<_Client>;
      store: Store;
    }) => Promise<void>;
  };

  message?: {
    schema?: _MessageSchema;
    /**
     * Optional platform-specific sugar methods bound to `PlatformMessage<Def>`.
     *
     * Each entry is a `ContentBuilder` factory whose **first parameter** is
     * the message itself (`self`); `buildMessage` injects a thin wrapper
     * that supplies `self` and calls `space.send(factory(self, ...args))`.
     * The wrapper is typed as `(...args) => Promise<void>` on
     * `PlatformMessage<Def>` via `MessageActionMethods<Def>`.
     *
     * Mirrors `space.actions` — `space.actions` lives on the space slot for
     * chat-level sugar (e.g. `space.background(...)`); `message.actions`
     * lives here for per-message sugar that needs `self` (e.g.
     * `message.read()`).
     *
     * Names that collide with reserved `Message` keys (`react`, `reply`,
     * `edit`, `id`, `space`, `sender`, `content`, `platform`, `direction`,
     * `timestamp`) are skipped at runtime with a warning and excluded at
     * the type level.
     */
    actions?: _MessageActions;
  };

  /**
   * Inbound message stream. Returns an `AsyncIterable<ProviderMessageRecord>`
   * — Spectrum wraps each emitted record into a fully-built `Message` and
   * fans it out via `spectrum.messages`.
   *
   * One of the two universal platform contracts (along with `send`). 99% of
   * integrations only need to implement `messages` + `send`.
   */
  messages: EventProducer<_MessageType, _Client, z.infer<_ConfigSchema>>;
  name: _Name;

  /**
   * Send a piece of `Content` to a space. The provider inspects
   * `content.type` and dispatches accordingly — text, attachments, reactions,
   * replies, edits, typing indicators, and any other content type all flow
   * through this single action.
   *
   * Returns a `ProviderMessageRecord` (id + timestamp) for content that
   * produces a message; returns `undefined` for fire-and-forget control
   * signals (reactions, typing, edits) on platforms that don't return ids.
   *
   * One of the two universal platform contracts (along with `messages`).
   */
  send: (_: {
    space: _ResolvedSpace & SpaceRef;
    content: Content;
    client: NoInferClient<_Client>;
    config: z.infer<_ConfigSchema>;
    store: Store;
  }) => Promise<ProviderMessageRecord | undefined>;

  space: {
    schema?: _SpaceSchema;
    params?: _SpaceParamsSchema;
    resolve: (_: {
      input: {
        users: (_ResolvedUser & { __platform: _Name })[];
        params?: _SpaceParamsSchema extends z.ZodType<object>
          ? z.infer<_SpaceParamsSchema>
          : undefined;
      };
      client: NoInferClient<_Client>;
      config: z.infer<_ConfigSchema>;
      store: Store;
    }) => Promise<_ResolvedSpace>;
    /**
     * Optional platform-specific sugar methods bound to `PlatformSpace<Def>`.
     *
     * Each entry is a `ContentBuilder` factory; `buildSpace` injects a thin
     * wrapper that calls `space.send(factory(...args))`. The wrapper is
     * typed as `(...args) => Promise<OutboundMessage | undefined>` on
     * `PlatformSpace<Def>` via `SpaceActionMethods<Def>`.
     *
     * Mirrors the top-level `PlatformDef.actions` slot — `actions` lives at
     * the platform level for capabilities (e.g. `getMessage`); `space.actions`
     * lives here for sugar that delegates through `send`.
     *
     * Names that collide with reserved `Space` keys (`send`, `edit`,
     * `getMessage`, `startTyping`, `stopTyping`, `responding`, `id`,
     * `__platform`) are skipped at runtime with a warning and excluded at
     * the type level.
     */
    actions?: _SpaceActions;
  };

  user: {
    schema?: _UserSchema;
    resolve: (_: {
      input: { userID: string };
      client: NoInferClient<_Client>;
      config: z.infer<_ConfigSchema>;
      store: Store;
    }) => Promise<_ResolvedUser>;
  };
}

// ---------------------------------------------------------------------------
// AnyPlatformDef — structural wildcard for erasure contexts
// ---------------------------------------------------------------------------

export interface AnyPlatformDef {
  actions?: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    getMessage?: (_: any) => Promise<any>;
  };
  config: z.ZodType<object>;

  // Optional escape hatches.
  events?: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard event
    [key: string]: (ctx: any) => AsyncIterable<any>;
  };
  lifecycle: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard lifecycle
    createClient: (ctx: any) => Promise<any>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard lifecycle
    destroyClient?: (ctx: any) => Promise<void>;
  };
  message?: {
    schema?: z.ZodType<object>;
    actions?: Record<string, MessageActionFactory>;
  };

  // Required core message I/O — the universal contract.
  // biome-ignore lint/suspicious/noExplicitAny: wildcard event
  messages: (ctx: any) => AsyncIterable<any>;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: wildcard action
  send: (_: any) => Promise<ProviderMessageRecord | undefined>;
  space: {
    schema?: z.ZodType<object>;
    params?: z.ZodType<object>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard resolver
    resolve: (_: any) => Promise<any>;
    actions?: Record<string, SpaceActionFactory>;
  };
  user: {
    schema?: z.ZodType<object>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard resolver
    resolve: (_: any) => Promise<any>;
  };
}

// ---------------------------------------------------------------------------
// PlatformProviderConfig — carries platform def type through providers array
// ---------------------------------------------------------------------------

export interface PlatformProviderConfig<
  Def extends AnyPlatformDef = AnyPlatformDef,
> {
  readonly __def: Def;
  readonly __definition: AnyPlatformDef;
  readonly __name: Def["name"];
  readonly __tag: "PlatformProviderConfig";
  readonly config: unknown;
}

// ---------------------------------------------------------------------------
// HotScript Fn's for type-level provider operations
// ---------------------------------------------------------------------------

interface MatchesPlatformName<Name extends string> extends Fn {
  return: this["arg0"] extends PlatformProviderConfig<infer Def>
    ? Def["name"] extends Name
      ? true
      : false
    : false;
}

interface ExtractDef extends Fn {
  return: this["arg0"] extends PlatformProviderConfig<infer Def> ? Def : never;
}

interface ExtractDefByName<Name extends string> extends Fn {
  return: this["arg0"] extends { name: Name } ? true : false;
}

// ---------------------------------------------------------------------------
// HotScript Fn's for custom event operations
// ---------------------------------------------------------------------------

interface ExtractCustomEventNames extends Fn {
  return: this["arg0"] extends AnyPlatformDef
    ? this["arg0"]["events"] extends Record<string, unknown>
      ? Exclude<keyof this["arg0"]["events"], symbol | number>
      : never
    : never;
}

interface ToCustomEventVariant<EventName extends string> extends Fn {
  return: this["arg0"] extends PlatformProviderConfig<infer Def>
    ? Def["events"] extends Record<string, unknown>
      ? EventName extends keyof Def["events"]
        ? InferEventPayload<Def["events"][EventName]> & {
            platform: Def["name"];
          }
        : never
      : never
    : never;
}

// ---------------------------------------------------------------------------
// HasProvider — check if a platform name exists in providers tuple
// ---------------------------------------------------------------------------

export type HasProvider<
  Providers extends PlatformProviderConfig[],
  Name extends string,
> = Pipe<Providers, [Tuples.Some<MatchesPlatformName<Name>>]>;

// ---------------------------------------------------------------------------
// ExtractProviderDef — pull a platform's def from the providers tuple
// ---------------------------------------------------------------------------

export type ExtractProviderDef<
  Providers extends PlatformProviderConfig[],
  Name extends string,
> = Pipe<
  Providers,
  [Tuples.Map<ExtractDef>, Tuples.Find<ExtractDefByName<Name>>]
>;

// ---------------------------------------------------------------------------
// AllCustomEventNames — union of all custom event names across providers
// ---------------------------------------------------------------------------

type AllCustomEventNames<Providers extends PlatformProviderConfig[]> = Pipe<
  Providers,
  [Tuples.Map<ExtractDef>, Tuples.Map<ExtractCustomEventNames>, Tuples.ToUnion]
>;

// ---------------------------------------------------------------------------
// UnifiedCustomEvent — for a given event name, union of payloads across providers
// ---------------------------------------------------------------------------

type UnifiedCustomEvent<
  Providers extends PlatformProviderConfig[],
  EventName extends string,
> = Pipe<
  Providers,
  [Tuples.Map<ToCustomEventVariant<EventName>>, Tuples.ToUnion]
>;

// ---------------------------------------------------------------------------
// CustomEventStreams — mapped type producing async iterables for each custom event
// ---------------------------------------------------------------------------

export type CustomEventStreams<Providers extends PlatformProviderConfig[]> = {
  [K in Exclude<AllCustomEventNames<Providers>, ReservedNames> &
    string]: AsyncIterable<UnifiedCustomEvent<Providers, K>>;
};

// ---------------------------------------------------------------------------
// Platform-specific Space, Message, and User types
// ---------------------------------------------------------------------------

type ResolvedSpaceOf<Def extends AnyPlatformDef> = AwaitedReturn<
  Def["space"]["resolve"]
>;
type SchemaSpaceOf<Def extends AnyPlatformDef> = InferOptionalSchema<
  Def["space"]["schema"]
>;

type ResolvedUserOf<Def extends AnyPlatformDef> = AwaitedReturn<
  Def["user"]["resolve"]
>;

type SpaceShapeOf<Def extends AnyPlatformDef> = [SchemaSpaceOf<Def>] extends [
  never,
]
  ? ResolvedSpaceOf<Def>
  : SchemaSpaceOf<Def>;

type SpaceParamsInputOf<Def extends AnyPlatformDef> = InputSchema<
  Def["space"]["params"]
>;

type SpaceUserLike<Def extends AnyPlatformDef> = PlatformUser<Def> | string;

type SpaceArrayArgs<Def extends AnyPlatformDef> = [
  SpaceParamsInputOf<Def>,
] extends [never]
  ? [users: SpaceUserLike<Def>[]]
  :
      | [users: SpaceUserLike<Def>[]]
      | [users: SpaceUserLike<Def>[], params: SpaceParamsInputOf<Def>]
      | [params: SpaceParamsInputOf<Def>];

type SpaceVarargArgs<Def extends AnyPlatformDef> = [
  SpaceParamsInputOf<Def>,
] extends [never]
  ? SpaceUserLike<Def>[]
  : SpaceUserLike<Def>[] | [...SpaceUserLike<Def>[], SpaceParamsInputOf<Def>];

type SpaceArgs<Def extends AnyPlatformDef> =
  | SpaceArrayArgs<Def>
  | SpaceVarargArgs<Def>;

// Methods derived from `PlatformDef.space.actions`. Each factory becomes a
// space method that delegates through `space.send`. Reserved `Space` keys
// (`send`, `edit`, …) are filtered out so universal sugar always wins.
type SpaceActionFactories<Def extends AnyPlatformDef> = Def["space"] extends {
  actions?: infer A;
}
  ? A extends Record<string, SpaceActionFactory>
    ? A
    : Record<string, never>
  : Record<string, never>;

export type SpaceActionMethods<Def extends AnyPlatformDef> = {
  [K in Exclude<keyof SpaceActionFactories<Def>, keyof Space>]: (
    ...args: Parameters<SpaceActionFactories<Def>[K]>
  ) => Promise<OutboundMessage | undefined>;
};

// Methods derived from `PlatformDef.message.actions`. Each factory's first
// parameter is bound to the message itself at build time, so the public
// surface drops it. Reserved `Message` keys (`react`, `reply`, `edit`, …)
// are filtered out so universal sugar always wins.
// `NonNullable<Def["message"]>` strips the `undefined` introduced by the
// optional `message?:` slot — without it, the outer conditional
// (`Def["message"] extends { actions?: infer A }`) fails because `undefined`
// is not assignable to `{ actions?: … }`, and the whole type collapses to
// the empty fallback, losing every declared action.
type MessageActionFactories<Def extends AnyPlatformDef> =
  NonNullable<Def["message"]> extends {
    actions?: infer A;
  }
    ? A extends Record<string, MessageActionFactory>
      ? A
      : Record<string, never>
    : Record<string, never>;

type TailArgs<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : [];

export type MessageActionMethods<Def extends AnyPlatformDef> = {
  [K in Exclude<keyof MessageActionFactories<Def>, keyof Message>]: (
    ...args: TailArgs<Parameters<MessageActionFactories<Def>[K]>>
  ) => Promise<void>;
};

// Both `keyof Space` and `keyof SpaceActionMethods<Def>` are removed from the
// schema shape before merging — at runtime `buildSpace` spreads
// `platformActions` after `extras`/`spaceRef`, so an action with the same
// name as a schema field overrides the field. Stripping both at the type
// level mirrors that and avoids an impossible `field & method` intersection.
export type PlatformSpace<Def extends AnyPlatformDef> = Omit<
  SpaceShapeOf<Def>,
  keyof Space | keyof SpaceActionMethods<Def>
> &
  Space &
  SpaceActionMethods<Def>;

// Both `keyof Message` and `keyof MessageActionMethods<Def>` are removed from
// the schema shape before merging — at runtime `buildMessage` spreads
// `platformActions` after `extras`, so an action with the same name as a
// schema field overrides the field. Stripping both at the type level mirrors
// that and avoids an impossible `field & method` intersection.
export type PlatformMessage<Def extends AnyPlatformDef> = Omit<
  SchemaInfer<Def["message"]>,
  keyof Message | keyof MessageActionMethods<Def>
> &
  Message<Def["name"], PlatformUser<Def>, PlatformSpace<Def>> &
  MessageActionMethods<Def>;

export type InboundPlatformMessage<Def extends AnyPlatformDef> = Omit<
  SchemaInfer<Def["message"]>,
  keyof InboundMessage | keyof MessageActionMethods<Def>
> &
  InboundMessage<Def["name"], PlatformUser<Def>, PlatformSpace<Def>> &
  MessageActionMethods<Def>;

export type PlatformUser<Def extends AnyPlatformDef> = Omit<
  ResolvedUserOf<Def>,
  keyof User
> &
  User;

// ---------------------------------------------------------------------------
// PlatformInstance — returned from imessage(spectrum)
// ---------------------------------------------------------------------------

export type PlatformInstance<Def extends AnyPlatformDef> = {
  readonly messages: AsyncIterable<
    [PlatformSpace<Def>, InboundPlatformMessage<Def>]
  >;
  space(...args: SpaceArgs<Def>): Promise<PlatformSpace<Def>>;
  user(userID: string): Promise<PlatformUser<Def>>;
} & CustomEventInstanceProperties<Def>;

// Project the optional `events?` slot onto the platform instance as flat
// async-iterable properties. When `events` is undefined (the 99% case), this
// resolves to `Record<never, never>` — no extra keys on the instance.
type CustomEventInstanceProperties<Def extends AnyPlatformDef> =
  Def["events"] extends Record<string, unknown>
    ? {
        [K in Exclude<
          keyof Def["events"],
          symbol | number
        > as K extends ReservedNames ? never : K]: AsyncIterable<
          InferEventPayload<NonNullable<Def["events"]>[K]>
        >;
      }
    : Record<never, never>;

// ---------------------------------------------------------------------------
// SpectrumLike — minimal interface for platform narrowing
// ---------------------------------------------------------------------------

export interface PlatformRuntime {
  client: unknown;
  config: unknown;
  definition: AnyPlatformDef;
  store: Store;
  subscribeMessages: () => ManagedStream<[Space, InboundMessage]>;
}

export interface SpectrumLike<
  Providers extends PlatformProviderConfig[] = PlatformProviderConfig[],
> {
  readonly __internal: {
    platforms: Map<string, PlatformRuntime>;
  };
  readonly __providers: Providers;
}

// ---------------------------------------------------------------------------
// Platform — the callable returned by definePlatform()
// ---------------------------------------------------------------------------

export interface Platform<Def extends AnyPlatformDef> {
  config(
    ...args: Record<string, never> extends z.input<Def["config"]>
      ? [config?: z.input<Def["config"]>]
      : [config: z.input<Def["config"]>]
  ): PlatformProviderConfig<Def>;
  is(input: Message): input is PlatformMessage<Def>;
  is(input: Space): input is PlatformSpace<Def>;
  is(input: unknown): input is PlatformMessage<Def> | PlatformSpace<Def>;
  <Providers extends PlatformProviderConfig[]>(
    spectrum: SpectrumLike<Providers>
  ): HasProvider<Providers, Def["name"]> extends true
    ? PlatformInstance<Def>
    : never;

  (space: Space): PlatformSpace<Def>;

  (message: Message): PlatformMessage<Def>;
}

export type { Message } from "../types/message";
