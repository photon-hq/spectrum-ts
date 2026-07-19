import type { Fn, Pipe, Tuples } from "hotscript";
import type z from "zod";
import type { AvatarData } from "../content/avatar";
import type { Content } from "../content/types";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import type { User } from "../types/user";
import type { ProjectData } from "../utils/cloud";
import type { Store } from "../utils/store";
import type { ManagedStream } from "../utils/stream";

/**
 * A platform-defined method on `Space`. The first parameter is bound to the
 * built `Space` at construction time, so callers only pass the trailing args.
 * Actions are plain functions returning `Promise<void>` — they can delegate
 * through `space.send(...)`, call the underlying SDK, or perform any other
 * side effect.
 *
 * Names that collide with reserved `Space` keys (`send`, `edit`, `unsend`,
 * `read`, `getMessage`, `getMembers`, `getAvatar`, `rename`, `avatar`, `add`,
 * `remove`, `leave`, `startTyping`, `stopTyping`, `responding`, `id`,
 * `__platform`) are skipped at runtime with a warning and excluded at the
 * type level via `Exclude<…, keyof Space>`.
 */
export type SpaceActionFn = (space: Space, ...args: never[]) => Promise<void>;

/**
 * A platform-defined method on `Message`. The first parameter is bound to
 * the message itself (`self`) at build time, so callers only pass the
 * trailing args. Actions are plain functions returning `Promise<void>` —
 * they can delegate through `message.space.send(...)`, call the underlying
 * SDK, or perform any other side effect.
 *
 * Names that collide with reserved `Message` keys (`react`, `reply`, `edit`,
 * `unsend`, `id`, `space`, `sender`, `content`, `platform`, `direction`,
 * `timestamp`) are skipped at runtime with a warning and excluded at the
 * type level via `Exclude<…, keyof Message>`.
 */
export type MessageActionFn = (
  message: Message,
  ...args: never[]
) => Promise<void>;

/**
 * A platform-defined method projected onto the value returned by
 * `provider(spectrum)` (e.g. `imessage(spectrum).getAttachment(guid)`). The
 * first parameter is an injected runtime context (`{ client, config, store }`);
 * `createPlatformInstance` supplies it so callers only pass the trailing args.
 *
 * Unlike `SpaceActionFn` / `MessageActionFn` (which always return
 * `Promise<void>` because they dispatch through `send`), instance actions
 * return arbitrary data — the public signature preserves the declared return
 * type via `InstanceActionMethods<Def>`.
 *
 * Two tiers live in the same `actions?` slot:
 *
 * - **Platform-wise actions** — fixed framework-known names (`getMessage`,
 *   `getMembers`, `getAvatar`) whose signatures are defined by
 *   `PlatformWiseActions`. They power universal sugar
 *   (`space.getMessage(id)`, `space.getMembers()`, `space.getAvatar()`) AND
 *   surface on the platform instance. If a provider omits one, the framework
 *   wires a default that throws `UnsupportedError`.
 * - **Platform-specific actions** — free-form keys each platform declares
 *   for its own ergonomics (e.g. iMessage's `getAttachment`). Surface on
 *   the platform instance only.
 *
 * Names that collide with reserved instance keys (`user`, `space`, `messages`,
 * plus any declared `events` key) are skipped at runtime with a warning and
 * excluded at the type level.
 */
export type InstanceActionFn = (
  // biome-ignore lint/suspicious/noExplicitAny: ctx is `any` so providers can annotate it with their platform's typed client without fighting contravariance; the runtime always passes `{ client, config, store }`
  ctx: any,
  // biome-ignore lint/suspicious/noExplicitAny: trailing args are user-defined
  ...args: any[]
) => Promise<unknown>;

/**
 * Framework-known action names that every platform implicitly has.
 *
 * Each entry's signature lives here; the framework wires the corresponding
 * method onto the `PlatformInstance` for every platform — providers override
 * by declaring the key inside their `actions` slot, and platforms that omit
 * the key get a default that throws `UnsupportedError`.
 *
 * Add a new platform-wise capability by extending this record along with:
 * `PlatformWiseInstanceMethods` (the public instance signature), the runtime
 * list `PLATFORM_WISE_ACTION_KEYS` in `build.ts`, and — when the capability
 * surfaces as universal `Space` sugar — the `Space` interface plus a
 * `buildSpace` impl and `RESERVED_SPACE_KEYS` entry. The instance method is
 * then surfaced on every `PlatformInstance` automatically.
 */
export interface PlatformWiseActions<
  _ResolvedSpace extends { id: string },
  _MessageType,
  _Client,
  _Config,
> {
  getAvatar: (
    ctx: { client: _Client; config: _Config; store: Store },
    space: _ResolvedSpace & { id: string; __platform: string }
  ) => Promise<AvatarData | undefined>;
  getDisplayName: (
    ctx: { client: _Client; config: _Config; store: Store },
    space: _ResolvedSpace & { id: string; __platform: string }
  ) => Promise<string | undefined>;
  getMembers: (
    ctx: { client: _Client; config: _Config; store: Store },
    space: _ResolvedSpace & { id: string; __platform: string }
  ) => Promise<readonly ProviderUserRecord[]>;
  getMessage: (
    ctx: { client: _Client; config: _Config; store: Store },
    space: _ResolvedSpace & { id: string; __platform: string },
    messageId: string
  ) => Promise<_MessageType | undefined>;
}

export type PlatformWiseActionKey = keyof PlatformWiseActions<
  { id: string },
  unknown,
  unknown,
  unknown
>;

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
  /**
   * Spectrum Cloud project metadata, fetched once at `Spectrum()` init.
   * `undefined` when the instance was created without `projectId`/`projectSecret`
   * (local-only setups). Providers read project-level toggles from
   * `projectConfig.profile.<key>` — e.g. iMessage's `imessageSynced` flag.
   */
  projectConfig: ProjectData | undefined;
  store: Store;
}) => AsyncIterable<TPayload>;

export type ProviderMessage<
  TSender extends ResolvedUser = ResolvedUser,
  TSpace extends ResolvedSpace = ResolvedSpace,
  TExtra extends object = Record<never, never>,
> = {
  id: string;
  content: Content;
  // Optional so providers can surface system signals with no attributable
  // author (e.g. a membership change whose platform recorded no actor) —
  // mirrors `ProviderMessageRecord.sender` and `Message.sender | undefined`.
  sender?: TSender;
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
  direction?: "inbound" | "outbound";
  sender?: { id: string } & Record<string, unknown>;
  space: { id: string } & Record<string, unknown>;
  timestamp?: Date;
} & Record<string, unknown>;

/**
 * A chat participant a provider returned from `actions.getMembers` — the raw
 * record shape, mirroring `ProviderMessageRecord.sender`. `id` is the user's
 * canonical platform identifier (the same handle format `space.create`
 * accepts); platform extras (e.g. iMessage's `address`/`country`/`service`)
 * ride along untyped. `space.getMembers()` tags each record with
 * `__platform` before surfacing it as a `User`.
 */
export type ProviderUserRecord = { id: string } & Record<string, unknown>;

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

// A custom event channel is declared either as a long-lived producer (regular
// platforms) or — for fusor platforms — as a Zod schema whose inferred type is
// the channel payload. Check the schema form first (a ZodType is not callable).
type InferEventPayload<T> = T extends z.ZodType
  ? z.infer<T>
  : T extends (ctx: never) => AsyncIterable<infer P>
    ? P
    : never;

// ---------------------------------------------------------------------------
// Reserved names — event names that would collide with SpectrumInstance methods
// ---------------------------------------------------------------------------

type ReservedNames = "stop" | "send" | "config" | "__internal" | "__providers";

// ---------------------------------------------------------------------------
// PlatformDef — the full definition of a platform adapter
// ---------------------------------------------------------------------------

export interface CreateClientContext<_ConfigSchema extends z.ZodType<object>> {
  config: z.infer<_ConfigSchema>;
  /**
   * The resolved cloud project record (slug, profile, …) when `Spectrum()` runs
   * with `projectId` + `projectSecret`; `undefined` in local/direct mode. Lets
   * `createClient` self-register provider webhooks against the Fusor edge keyed
   * by `projectConfig.slug` — see Telegram.
   */
  projectConfig: ProjectData | undefined;
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
        // Regular platforms supply a producer; fusor platforms declare a Zod
        // schema (the channel payload type) and emit via `fusorEvent(...)`. The
        // schema must produce an object — event payloads are spread with a
        // `platform` tag, so non-object outputs (e.g. `z.string()`) are invalid.
        | EventProducer<unknown, _Client, z.infer<_ConfigSchema>>
        | z.ZodType<object>
      > & { messages?: never })
    | undefined = undefined,
  _SpaceActions extends Record<string, SpaceActionFn> = Record<never, never>,
  _MessageActions extends Record<string, MessageActionFn> = Record<
    never,
    never
  >,
  _Actions extends Record<string, InstanceActionFn> = Record<never, never>,
> {
  /**
   * Provider-defined methods exposed on the platform instance.
   *
   * Two tiers share this slot:
   *
   * 1. **Platform-wise actions** (`getMessage`, `getMembers`, `getAvatar`) —
   *    framework-recognized names declared in `PlatformWiseActions`. Override
   *    by declaring the key here with the matching signature. The framework
   *    injects `ctx = { client, config, store }` as the first arg and
   *    surfaces the method on the platform instance
   *    (`im.getMessage(space, id)`). If omitted, the framework wires a
   *    default that throws `UnsupportedError`. Powers universal sugar like
   *    `space.getMessage(id)`.
   *
   * 2. **Platform-specific actions** — free-form keys like `getAttachment`.
   *    Each gets `ctx = { client, config, store }` as the first arg; the
   *    public signature on `PlatformInstance<Def>` drops `ctx` and preserves
   *    the declared return type.
   *
   * Names that collide with reserved instance keys (`user`, `space`,
   * `messages`, plus any declared `events` key) are skipped at runtime with
   * a warning and excluded at the type level.
   */
  actions?: Partial<
    PlatformWiseActions<
      _ResolvedSpace,
      _MessageType,
      NoInferClient<_Client>,
      z.infer<_ConfigSchema>
    >
  > &
    _Actions;

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
   * Inbound message stream.
   *
   * - **Default mode**: returns an `AsyncIterable<ProviderMessageRecord>` —
   *   Spectrum wraps each emitted record into a fully-built `Message` and
   *   fans it out via `spectrum.messages`.
   * - **Fusor mode**: when `lifecycle.createClient` returns a `FusorClient`
   *   (constructed via `fusor(platform, verify)`), the signature switches to a
   *   per-payload callback `(ctx: { payload, respond }) => …` whose return
   *   value is the message(s) to emit and whose optional `respond` call
   *   customises the HTTP reply sent back to fusor.
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
   * produces a message — including reactions, whose record is the unsend
   * handle (synthesize a deterministic id when the platform assigns none);
   * returns `undefined` only for fire-and-forget control signals (typing,
   * edits, renames, avatars, unsends) on platforms that don't return ids.
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
    create: (_: {
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
     * Optional: hydrate a space from a known platform space id. When absent,
     * the framework builds the candidate `{ id }` and validates it against
     * `space.schema` — providers whose schema requires more fields must
     * implement this.
     */
    get?: (_: {
      input: {
        id: string;
        params?: _SpaceParamsSchema extends z.ZodType<object>
          ? z.infer<_SpaceParamsSchema>
          : undefined;
      };
      client: NoInferClient<_Client>;
      config: z.infer<_ConfigSchema>;
      store: Store;
    }) => Promise<_ResolvedSpace>;
    /**
     * Optional platform-specific methods bound to `PlatformSpace<Def>`.
     *
     * Each entry is a plain async function `(space, ...args) => Promise<void>`;
     * `buildSpace` injects the built `PlatformSpace<Def>` as the first
     * argument and exposes the trailing args as the public surface. Action
     * implementations choose how to dispatch — `space.send(...)`, a direct
     * SDK call, or any other side effect — and always return `Promise<void>`
     * to callers.
     *
     * Mirrors the top-level `PlatformDef.actions` slot — `actions` lives at
     * the platform level for capabilities (e.g. `getMessage`); `space.actions`
     * lives here for platform-specific surface area.
     *
     * Names that collide with reserved `Space` keys (`send`, `edit`,
     * `unsend`, `read`, `getMessage`, `getMembers`, `getAvatar`, `rename`,
     * `avatar`, `add`, `remove`, `leave`, `startTyping`, `stopTyping`,
     * `responding`, `id`, `__platform`) are skipped at runtime with a
     * warning and excluded at the type level.
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
  actions?: Record<string, InstanceActionFn>;
  config: z.ZodType<object>;

  // Optional escape hatches. A channel is either a producer (regular platforms)
  // or an object-output Zod schema declaring the payload of a fusor
  // `fusorEvent(...)` channel.
  events?: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard event
    [key: string]: ((ctx: any) => AsyncIterable<any>) | z.ZodType<object>;
  };

  lifecycle: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard lifecycle
    createClient: (ctx: any) => Promise<any>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard lifecycle
    destroyClient?: (ctx: any) => Promise<void>;
  };
  message?: {
    schema?: z.ZodType<object>;
    actions?: Record<string, MessageActionFn>;
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
    create: (_: any) => Promise<any>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard resolver
    get?: (_: any) => Promise<any>;
    actions?: Record<string, SpaceActionFn>;
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
// HasProvider — check if a platform id exists in providers tuple
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
  Def["space"]["create"]
>;
type SchemaSpaceOf<Def extends AnyPlatformDef> = InferOptionalSchema<
  Def["space"]["schema"]
>;

type ResolvedUserOf<Def extends AnyPlatformDef> = AwaitedReturn<
  Def["user"]["resolve"]
>;
type SchemaUserOf<Def extends AnyPlatformDef> = InferOptionalSchema<
  Def["user"]["schema"]
>;

type SpaceShapeOf<Def extends AnyPlatformDef> = [SchemaSpaceOf<Def>] extends [
  never,
]
  ? ResolvedSpaceOf<Def>
  : SchemaSpaceOf<Def>;

// Mirrors `SpaceShapeOf`: a declared `user.schema` is authoritative for the
// app-facing sender shape; without one we fall back to `user.resolve`'s
// return type so providers that declare no schema are unaffected.
type UserShapeOf<Def extends AnyPlatformDef> = [SchemaUserOf<Def>] extends [
  never,
]
  ? ResolvedUserOf<Def>
  : SchemaUserOf<Def>;

// When a provider declares no `space.params`, `definePlatform`'s
// `_SpaceParamsSchema` has no inference candidate and falls back to its
// constraint — the broad `z.ZodType<object>`. A declared schema is always a
// strict subtype (e.g. `ZodObject<…>`), so "is the broad type assignable
// here?" cleanly separates absent (→ never, no params argument) from declared.
type SpaceParamsInputOf<Def extends AnyPlatformDef> =
  z.ZodType<object> extends Def["space"]["params"]
    ? never
    : InputSchema<Def["space"]["params"]>;

type SpaceUserLike<Def extends AnyPlatformDef> = PlatformUser<Def> | string;

// Params tuple for `space.create` / `space.get`:
// - no params schema on the provider           → no params argument at all
// - schema with only optional fields           → optional trailing params
// - schema with required fields (slack teamId) → required trailing params
type SpaceParamsArgs<Def extends AnyPlatformDef> = [
  SpaceParamsInputOf<Def>,
] extends [never]
  ? []
  : Record<string, never> extends SpaceParamsInputOf<Def>
    ? [params?: SpaceParamsInputOf<Def>]
    : [params: SpaceParamsInputOf<Def>];

export interface SpaceNamespace<Def extends AnyPlatformDef> {
  /**
   * Resolve or create a space from its participants — a single user (1:1
   * conversation) or several (group, where the platform supports it). Users
   * may be raw id strings or previously resolved `PlatformUser`s.
   */
  create(
    users: SpaceUserLike<Def> | SpaceUserLike<Def>[],
    ...params: SpaceParamsArgs<Def>
  ): Promise<PlatformSpace<Def>>;
  /**
   * Construct a space from a known platform space id — e.g. one persisted
   * from an earlier event. Providers may hydrate platform-specific fields
   * (or verify existence) via their `space.get` hook.
   */
  get(id: string, ...params: SpaceParamsArgs<Def>): Promise<PlatformSpace<Def>>;
}

// Methods derived from `PlatformDef.space.actions`. The first parameter
// (`space`) is bound to the built `PlatformSpace<Def>` at construction time,
// so the public surface drops it. Reserved `Space` keys (`send`, `edit`, …)
// are filtered out so universal sugar always wins.
type SpaceActionFns<Def extends AnyPlatformDef> = Def["space"] extends {
  actions?: infer A;
}
  ? A extends Record<string, SpaceActionFn>
    ? A
    : Record<string, never>
  : Record<string, never>;

type TailArgs<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : [];

export type SpaceActionMethods<Def extends AnyPlatformDef> = {
  [K in Exclude<keyof SpaceActionFns<Def>, keyof Space>]: (
    ...args: TailArgs<Parameters<SpaceActionFns<Def>[K]>>
  ) => Promise<void>;
};

// Methods derived from `PlatformDef.message.actions`. The first parameter
// (`message`) is bound to the built message at construction time, so the
// public surface drops it. Reserved `Message` keys (`react`, `reply`,
// `edit`, …) are filtered out so universal sugar always wins.
// `NonNullable<Def["message"]>` strips the `undefined` introduced by the
// optional `message?:` slot — without it, the outer conditional
// (`Def["message"] extends { actions?: infer A }`) fails because `undefined`
// is not assignable to `{ actions?: … }`, and the whole type collapses to
// the empty fallback, losing every declared action.
type MessageActionFns<Def extends AnyPlatformDef> =
  NonNullable<Def["message"]> extends {
    actions?: infer A;
  }
    ? A extends Record<string, MessageActionFn>
      ? A
      : Record<string, never>
    : Record<string, never>;

export type MessageActionMethods<Def extends AnyPlatformDef> = {
  [K in Exclude<keyof MessageActionFns<Def>, keyof Message>]: (
    ...args: TailArgs<Parameters<MessageActionFns<Def>[K]>>
  ) => Promise<void>;
};

// Methods derived from `PlatformDef.actions`. The first parameter (`ctx`) is
// the runtime context (`{ client, config, store }`) injected by
// `createPlatformInstance`, so the public surface drops it. Unlike
// `SpaceActionMethods` / `MessageActionMethods`, the declared **return type**
// is preserved — instance actions return data, not `Promise<void>`.
// The inner `A extends Record<string, AnyInstanceActionFn>` uses a maximally
// permissive function shape so concrete actions (with typed `client`) flow
// through without contravariance fights.
type AnyInstanceActionFn = (
  // biome-ignore lint/suspicious/noExplicitAny: structural shape only
  ...args: any[]
) => Promise<unknown>;
type InstanceActionFns<Def extends AnyPlatformDef> = Def["actions"] extends
  | infer A
  | undefined
  ? A extends Record<string, AnyInstanceActionFn>
    ? A
    : Record<string, never>
  : Record<string, never>;

// Reserved keys on `PlatformInstance` — same set the runtime guards. Includes
// the base members (`user`, `space`, `messages`) plus every event name the
// platform projects onto the instance, plus the platform-wise action keys
// (`getMessage`, `getMembers`, `getAvatar`) whose public signatures come from
// `PlatformWiseInstanceMethods`.
type ReservedInstanceKeys<Def extends AnyPlatformDef> =
  | "user"
  | "space"
  | "messages"
  | PlatformWiseActionKey
  | Extract<keyof CustomEventInstanceProperties<Def>, string>;

// Methods derived from `PlatformDef.actions`, *excluding* platform-wise keys
// (those are covered by `PlatformWiseInstanceMethods<Def>` so their signatures
// stay typed even when the provider omits the override).
export type InstanceActionMethods<Def extends AnyPlatformDef> = {
  [K in Exclude<
    keyof InstanceActionFns<Def>,
    ReservedInstanceKeys<Def> | symbol | number
  >]: (
    ...args: TailArgs<Parameters<InstanceActionFns<Def>[K]>>
  ) => ReturnType<InstanceActionFns<Def>[K]>;
};

// Methods derived from `PlatformWiseActions` — always present on the
// platform instance regardless of whether the provider overrides them.
// Signatures use the platform's resolved Space/Message/User types so they
// type-check against `space.getMessage`-style sugar. The instance path
// returns the provider's records raw (no wrapping or `__platform` tagging —
// same pass-through contract as `im.getMessage`); the `space.*` sugar is the
// framework-normalized path.
export interface PlatformWiseInstanceMethods<Def extends AnyPlatformDef> {
  getAvatar: (space: PlatformSpace<Def>) => Promise<AvatarData | undefined>;
  getDisplayName: (space: PlatformSpace<Def>) => Promise<string | undefined>;
  getMembers: (space: PlatformSpace<Def>) => Promise<PlatformUser<Def>[]>;
  getMessage: (
    space: PlatformSpace<Def>,
    messageId: string
  ) => Promise<PlatformMessage<Def> | undefined>;
}

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

export type PlatformUser<Def extends AnyPlatformDef> = Omit<
  UserShapeOf<Def>,
  keyof User
> &
  User;

// ---------------------------------------------------------------------------
// PlatformInstance — returned from imessage(spectrum)
// ---------------------------------------------------------------------------

export type PlatformInstance<Def extends AnyPlatformDef> = {
  readonly messages: AsyncIterable<[PlatformSpace<Def>, PlatformMessage<Def>]>;
  readonly space: SpaceNamespace<Def>;
  user(userID: string): Promise<PlatformUser<Def>>;
} & CustomEventInstanceProperties<Def> &
  PlatformWiseInstanceMethods<Def> &
  InstanceActionMethods<Def>;

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
  // Spectrum Cloud project metadata, so instance-level event producers receive
  // the same `{ client, config, projectConfig, store }` context as the
  // top-level `spectrum.<event>` streams (the `EventProducer` contract).
  projectConfig: ProjectData | undefined;
  store: Store;
  // Fanout subscription to a fusor custom event channel (declared as a schema
  // under `events`). Returns `undefined` when the platform has no such channel
  // (e.g. every regular, producer-based platform). Fed by the `messages`
  // handler returning `fusorEvent(channel, data)`.
  subscribeEvent?: (channel: string) => AsyncIterable<unknown> | undefined;
  subscribeMessages: () => ManagedStream<[Space, Message]>;
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

// Every string-leaf config field falls back to `SPECTRUM_<PLATFORM>_<KEY>` at
// runtime (see `envAwareConfig`), so any declared field may be omitted and
// supplied by the environment instead. `ConfigInput` reflects that by making the
// top-level input keys optional. The conditional distributes over unions so a
// `direct | cloud` config input isn't collapsed to its shared keys.
type ConfigInput<Def extends AnyPlatformDef> =
  z.input<Def["config"]> extends infer Input
    ? Input extends unknown
      ? { [K in keyof Input]?: Input[K] }
      : never
    : never;

export interface Platform<Def extends AnyPlatformDef> {
  config(
    ...args: Record<string, never> extends ConfigInput<Def>
      ? [config?: ConfigInput<Def>]
      : [config: ConfigInput<Def>]
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
