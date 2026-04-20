import type { Fn, Pipe, Tuples } from "hotscript";
import type z from "zod";
import type { Content } from "../content/types";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import type { User } from "../types/user";

type ResolvedSpace = Pick<Space, "id">;
type SpaceRef = Pick<Space, "id" | "__platform">;
type ResolvedUser = Pick<User, "id">;
type AwaitedReturn<T> = T extends (...args: never[]) => Promise<infer R>
  ? R
  : never;
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
> = (ctx: { client: TClient; config: TConfig }) => AsyncIterable<TPayload>;

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

export interface SendResult<TSender extends ResolvedUser = ResolvedUser> {
  id: string;
  sender?: TSender;
  timestamp?: Date;
}

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
  _Events extends {
    messages: EventProducer<_MessageType, _Client, z.infer<_ConfigSchema>>;
  } = {
    messages: EventProducer<_MessageType, _Client, z.infer<_ConfigSchema>>;
  },
> {
  actions: {
    send: (_: {
      space: _ResolvedSpace & SpaceRef;
      content: Content;
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<SendResult<_ResolvedUser>>;
    startTyping?: (_: {
      space: _ResolvedSpace & SpaceRef;
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<void>;
    stopTyping?: (_: {
      space: _ResolvedSpace & SpaceRef;
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<void>;
    reactToMessage?: (_: {
      space: _ResolvedSpace & SpaceRef;
      messageId: string;
      reaction: string;
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<void>;
    replyToMessage?: (_: {
      space: _ResolvedSpace & SpaceRef;
      messageId: string;
      content: Content;
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<SendResult<_ResolvedUser>>;
    editMessage?: (_: {
      space: _ResolvedSpace & SpaceRef;
      messageId: string;
      content: Content;
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<void>;
  };

  config: _ConfigSchema;

  events: _Events;

  lifecycle: {
    createClient: (ctx: {
      config: z.infer<_ConfigSchema>;
      projectId: string | undefined;
      projectSecret: string | undefined;
    }) => Promise<_Client>;
    destroyClient: (ctx: { client: _Client }) => Promise<void>;
  };

  message?: {
    schema?: _MessageSchema;
  };
  name: _Name;

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
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<_ResolvedSpace>;
  };

  user: {
    schema?: _UserSchema;
    resolve: (_: {
      input: { userID: string };
      client: _Client;
      config: z.infer<_ConfigSchema>;
    }) => Promise<_ResolvedUser>;
  };
}

// ---------------------------------------------------------------------------
// AnyPlatformDef — structural wildcard for erasure contexts
// ---------------------------------------------------------------------------

export interface AnyPlatformDef {
  actions: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    send: (_: any) => Promise<SendResult>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    startTyping?: (_: any) => Promise<void>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    stopTyping?: (_: any) => Promise<void>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    reactToMessage?: (_: any) => Promise<void>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    replyToMessage?: (_: any) => Promise<SendResult>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard action
    editMessage?: (_: any) => Promise<void>;
  };
  config: z.ZodType<object>;
  events: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard event
    messages: (ctx: any) => AsyncIterable<any>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard event
    [key: string]: (ctx: any) => AsyncIterable<any>;
  };
  lifecycle: {
    // biome-ignore lint/suspicious/noExplicitAny: wildcard lifecycle
    createClient: (ctx: any) => Promise<any>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard lifecycle
    destroyClient: (ctx: any) => Promise<void>;
  };
  message?: { schema?: z.ZodType<object> };
  name: string;
  space: {
    schema?: z.ZodType<object>;
    params?: z.ZodType<object>;
    // biome-ignore lint/suspicious/noExplicitAny: wildcard resolver
    resolve: (_: any) => Promise<any>;
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
    ? Exclude<keyof this["arg0"]["events"], "messages" | symbol | number>
    : never;
}

interface ToCustomEventVariant<EventName extends string> extends Fn {
  return: this["arg0"] extends PlatformProviderConfig<infer Def>
    ? EventName extends keyof Def["events"]
      ? InferEventPayload<Def["events"][EventName]> & { platform: Def["name"] }
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
// AllCustomEventNames — union of all non-messages event names across providers
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

type SpaceArrayArgs<Def extends AnyPlatformDef> = [
  SpaceParamsInputOf<Def>,
] extends [never]
  ? [users: PlatformUser<Def>[]]
  :
      | [users: PlatformUser<Def>[]]
      | [users: PlatformUser<Def>[], params: SpaceParamsInputOf<Def>]
      | [params: SpaceParamsInputOf<Def>];

type SpaceVarargArgs<Def extends AnyPlatformDef> = [
  SpaceParamsInputOf<Def>,
] extends [never]
  ? PlatformUser<Def>[]
  : PlatformUser<Def>[] | [...PlatformUser<Def>[], SpaceParamsInputOf<Def>];

type SpaceArgs<Def extends AnyPlatformDef> =
  | SpaceArrayArgs<Def>
  | SpaceVarargArgs<Def>;

export type PlatformSpace<Def extends AnyPlatformDef> = Omit<
  SpaceShapeOf<Def>,
  keyof Space
> &
  Space;

export type PlatformMessage<Def extends AnyPlatformDef> = Omit<
  SchemaInfer<Def["message"]>,
  keyof Message
> &
  Message<Def["name"], PlatformUser<Def>, PlatformSpace<Def>>;

export type PlatformUser<Def extends AnyPlatformDef> = Omit<
  ResolvedUserOf<Def>,
  keyof User
> &
  User;

// ---------------------------------------------------------------------------
// PlatformInstance — returned from imessage(spectrum)
// ---------------------------------------------------------------------------

export type PlatformInstance<Def extends AnyPlatformDef> = {
  space(...args: SpaceArgs<Def>): Promise<PlatformSpace<Def>>;
  user(userID: string): Promise<PlatformUser<Def>>;
} & {
  [K in Exclude<
    keyof Def["events"],
    "messages" | symbol | number
  > as K extends ReservedNames ? never : K]: AsyncIterable<
    InferEventPayload<Def["events"][K]>
  >;
};

// ---------------------------------------------------------------------------
// SpectrumLike — minimal interface for platform narrowing
// ---------------------------------------------------------------------------

export interface SpectrumLike<
  Providers extends PlatformProviderConfig[] = PlatformProviderConfig[],
> {
  readonly __internal: {
    platforms: Map<
      string,
      { client: unknown; config: unknown; definition: AnyPlatformDef }
    >;
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
  <Providers extends PlatformProviderConfig[]>(
    spectrum: SpectrumLike<Providers>
  ): HasProvider<Providers, Def["name"]> extends true
    ? PlatformInstance<Def>
    : never;

  (space: Space): PlatformSpace<Def>;

  (message: Message): PlatformMessage<Def>;
}

export type { Message } from "../types/message";
