import { withSpan } from "@photon-ai/otel";
import type z from "zod";
import type { Content } from "../content/types";
import type { FusorClient, FusorMessages } from "../fusor/types";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import { classifyIdentifier as classifySingle } from "../utils/identifier";
import type { Store } from "../utils/store";
import { buildSpace } from "./build";
import type {
  AnyPlatformDef,
  CreateClientContext,
  EventProducer,
  MessageActionFn,
  Platform,
  PlatformDef,
  PlatformInstance,
  PlatformMessage,
  PlatformProviderConfig,
  PlatformRuntime,
  PlatformSpace,
  PlatformUser,
  ProviderMessage,
  ProviderMessageRecord,
  SpaceActionFn,
  SpectrumLike,
} from "./types";

function classifySpaceIdentifier(args: unknown[]): {
  kind: "phone" | "email" | "group" | "unknown";
  identifier?: string;
} {
  const stringArgs = args.filter((a): a is string => typeof a === "string");
  if (stringArgs.length > 1) {
    return { kind: "group" };
  }
  const s = stringArgs[0];
  if (!s) {
    return { kind: "unknown" };
  }
  const { kind, identifier } = classifySingle(s);
  if (kind === "unknown") {
    return { kind: "unknown" };
  }
  return { kind, identifier };
}

type NoInferValue<T> = [T][T extends unknown ? 0 : never];

function createPlatformInstance<
  Def extends AnyPlatformDef,
  _Client,
  _ConfigSchema extends z.ZodType<object>,
>(def: Def, runtime: PlatformRuntime): PlatformInstance<Def> {
  const isPlatformUser = (value: unknown): value is PlatformUser<Def> =>
    typeof value === "object" &&
    value !== null &&
    "__platform" in value &&
    (value as { __platform?: unknown }).__platform === def.name;

  const resolveUserID = async (userID: string): Promise<PlatformUser<Def>> => {
    const resolved = await def.user.resolve({
      input: { userID },
      client: runtime.client as _Client,
      config: runtime.config as z.infer<_ConfigSchema>,
      store: runtime.store,
    });
    return {
      ...resolved,
      __platform: def.name,
    } as PlatformUser<Def>;
  };

  const resolveStringUsers = async (args: unknown[]): Promise<unknown[]> => {
    const convertArg = async (arg: unknown): Promise<unknown> => {
      if (typeof arg === "string") {
        return await resolveUserID(arg);
      }
      if (Array.isArray(arg)) {
        return await Promise.all(arg.map(convertArg));
      }
      return arg;
    };
    return await Promise.all(args.map(convertArg));
  };

  const normalizeSpaceArgs = (
    args: unknown[]
  ): { users: PlatformUser<Def>[]; params: unknown } => {
    if (args.length === 0) {
      return { users: [], params: undefined };
    }

    const [first, ...rest] = args;
    if (Array.isArray(first)) {
      return {
        users: first as PlatformUser<Def>[],
        params: rest[0],
      };
    }

    if (!isPlatformUser(first)) {
      return {
        users: [],
        params: first,
      };
    }

    const last = args.at(-1);
    if (last !== undefined && !isPlatformUser(last)) {
      return {
        users: args.slice(0, -1) as PlatformUser<Def>[],
        params: last,
      };
    }

    return {
      users: args as PlatformUser<Def>[],
      params: undefined,
    };
  };

  const base = {
    async user(userID: string) {
      const resolved = await def.user.resolve({
        input: { userID },
        client: runtime.client as _Client,
        config: runtime.config as z.infer<_ConfigSchema>,
        store: runtime.store,
      });
      return {
        ...resolved,
        __platform: def.name,
      } as PlatformUser<Def>;
    },

    async space(...args: unknown[]) {
      const { kind, identifier } = classifySpaceIdentifier(args);
      return withSpan(
        "spectrum.space.resolve",
        {
          "spectrum.provider": def.name,
          "spectrum.space.identifier_kind": kind,
          "spectrum.space.identifier": identifier,
        },
        async () => {
          const convertedArgs = await resolveStringUsers(args);
          const { users, params } = normalizeSpaceArgs(convertedArgs);
          let parsedParams = params;
          if (params !== undefined && def.space.params) {
            parsedParams = def.space.params.parse(params);
          }
          const resolved = await def.space.resolve({
            input: { users, params: parsedParams },
            client: runtime.client as _Client,
            config: runtime.config as z.infer<_ConfigSchema>,
            store: runtime.store,
          });
          const parsedSpace = def.space.schema
            ? def.space.schema.parse(resolved)
            : resolved;
          const spaceRef = {
            ...(parsedSpace as Record<string, unknown>),
            id: parsedSpace.id,
            __platform: def.name,
          };
          const actionCtx = {
            space: spaceRef,
            client: runtime.client as _Client,
            config: runtime.config as z.infer<_ConfigSchema>,
            store: runtime.store,
          };
          return buildSpace({
            spaceRef,
            extras: parsedSpace as Record<string, unknown>,
            actionCtx,
            definition: def as unknown as AnyPlatformDef,
            client: runtime.client,
            config: runtime.config,
            store: runtime.store,
          }) as PlatformSpace<Def>;
        }
      );
    },
  };

  // Add flat event properties for custom events. The core `messages` stream
  // lives at the top level of the def — only the optional `events?` slot
  // (custom platform events like presence, read receipts, etc.) is projected
  // onto the instance here.
  const eventProperties: Record<string, AsyncIterable<unknown>> = {};
  const customEvents = def.events ?? {};
  for (const eventName of Object.keys(customEvents)) {
    const producer = customEvents[eventName] as
      | ((ctx: {
          client: unknown;
          config: unknown;
          store: Store;
        }) => AsyncIterable<unknown>)
      | undefined;
    if (producer) {
      eventProperties[eventName] = producer({
        client: runtime.client,
        config: runtime.config,
        store: runtime.store,
      });
    }
  }

  // Lazily subscribe to the platform's message broadcast on first read.
  // Cached so `for await (const x of im.messages)` twice doesn't double-subscribe.
  let messagesIterable:
    | AsyncIterable<[PlatformSpace<Def>, PlatformMessage<Def>]>
    | undefined;
  Object.defineProperty(base, "messages", {
    enumerable: true,
    get() {
      messagesIterable ??= runtime.subscribeMessages() as AsyncIterable<
        [PlatformSpace<Def>, PlatformMessage<Def>]
      >;
      return messagesIterable;
    },
  });

  return Object.assign(base, eventProperties) as PlatformInstance<Def>;
}

export function definePlatform<
  _Name extends string,
  _ConfigSchema extends z.ZodType<object>,
  _UserSchema extends z.ZodType<object> | undefined,
  _SpaceSchema extends z.ZodType<object> | undefined,
  _SpaceParamsSchema extends z.ZodType<object> | undefined,
  _Client,
  _ResolvedUser extends { id: string },
  _ResolvedSpace extends { id: string },
  _MessageSchema extends z.ZodType<object> | undefined = undefined,
  _MessageType extends ProviderMessage<
    _ResolvedUser,
    _ResolvedSpace,
    _MessageSchema extends z.ZodType<object>
      ? z.infer<_MessageSchema>
      : Record<never, never>
  > = ProviderMessage<
    _ResolvedUser,
    _ResolvedSpace,
    _MessageSchema extends z.ZodType<object>
      ? z.infer<_MessageSchema>
      : Record<never, never>
  >,
  _Events extends
    | (Record<
        string,
        EventProducer<unknown, _Client, z.infer<_ConfigSchema>>
      > & { messages?: never })
    | undefined = undefined,
  _Static extends Record<string, unknown> = Record<never, never>,
  _SpaceActions extends Record<string, SpaceActionFn> = Record<never, never>,
  _MessageActions extends Record<string, MessageActionFn> = Record<
    never,
    never
  >,
>(
  name: _Name,
  def: {
    lifecycle: {
      createClient: (
        ctx: CreateClientContext<_ConfigSchema>
      ) => Promise<_Client>;
      destroyClient?: (ctx: {
        client: NoInferValue<_Client>;
        store: Store;
      }) => Promise<void>;
    };
  } & Omit<
    PlatformDef<
      _Name,
      _ConfigSchema,
      _UserSchema,
      _SpaceSchema,
      _SpaceParamsSchema,
      _Client,
      _ResolvedUser,
      _ResolvedSpace,
      _MessageSchema,
      _MessageType,
      _Events,
      _SpaceActions,
      _MessageActions
    >,
    "lifecycle" | "name"
  > & { static?: _Static }
): Platform<
  PlatformDef<
    _Name,
    _ConfigSchema,
    _UserSchema,
    _SpaceSchema,
    _SpaceParamsSchema,
    _Client,
    _ResolvedUser,
    _ResolvedSpace,
    _MessageSchema,
    _MessageType,
    _Events,
    _SpaceActions,
    _MessageActions
  >
> &
  Readonly<_Static> {
  type Def = PlatformDef<
    _Name,
    _ConfigSchema,
    _UserSchema,
    _SpaceSchema,
    _SpaceParamsSchema,
    _Client,
    _ResolvedUser,
    _ResolvedSpace,
    _MessageSchema,
    _MessageType,
    _Events,
    _SpaceActions,
    _MessageActions
  >;

  const fullDef = { name, ...def };

  const platformCache = new WeakMap<SpectrumLike, PlatformInstance<Def>>();

  const narrowSpectrum = (spectrum: SpectrumLike) => {
    const cached = platformCache.get(spectrum);
    if (cached) {
      return cached;
    }

    const runtime = spectrum.__internal.platforms.get(name);
    if (!runtime) {
      throw new Error(`Platform "${name}" is not registered`);
    }

    const instance = createPlatformInstance<Def, _Client, _ConfigSchema>(
      fullDef as Def & AnyPlatformDef,
      runtime
    );
    platformCache.set(spectrum, instance);
    return instance;
  };

  const narrowSpace = (input: Space) => {
    if (input.__platform !== name) {
      throw new Error(
        `Expected space from "${name}", got "${input.__platform}"`
      );
    }
    return input as PlatformSpace<Def>;
  };

  const narrowMessage = (input: Message) => {
    if (input.platform !== name) {
      throw new Error(
        `Expected message from "${name}", got "${input.platform}"`
      );
    }
    return input as PlatformMessage<Def>;
  };

  const narrower = ((input: SpectrumLike | Space | Message) => {
    if ("__providers" in input && "__internal" in input) {
      return narrowSpectrum(input as SpectrumLike);
    }
    if ("__platform" in input && "send" in input) {
      return narrowSpace(input as Space);
    }
    if ("platform" in input && "sender" in input && "space" in input) {
      return narrowMessage(input as Message);
    }
    throw new Error("Invalid input to platform narrowing function");
  }) as Platform<Def>;

  narrower.config = (config?: z.input<_ConfigSchema>) => {
    const resolvedConfig = config ?? {};
    return {
      __tag: "PlatformProviderConfig" as const,
      __def: undefined as unknown as Def,
      __name: name,
      config: resolvedConfig,
      __definition: fullDef as AnyPlatformDef,
    } satisfies PlatformProviderConfig<Def> as PlatformProviderConfig<Def>;
  };

  narrower.is = ((input: unknown) => {
    if (typeof input !== "object" || input === null) {
      return false;
    }
    if ("__platform" in input) {
      return (input as { __platform?: unknown }).__platform === name;
    }
    if ("platform" in input) {
      return (input as { platform?: unknown }).platform === name;
    }
    return false;
  }) as Platform<Def>["is"];

  if (def.static) {
    Object.assign(narrower, def.static);
  }

  return narrower as Platform<Def> & Readonly<_Static>;
}

// ---------------------------------------------------------------------------
// defineFusorPlatform — fusor-mode entrypoint
// ---------------------------------------------------------------------------
//
// Sibling to `definePlatform` for webhook-driven platforms whose
// `lifecycle.createClient` returns `fusor(platform, verify)`. In fusor mode
// there is no long-lived SDK client to talk to, and the `messages` callback
// runs once per inbound webhook against an already-verified payload — its
// return value becomes the message(s) emitted on `spectrum.messages`, and an
// optional `respond(reply)` call customises the HTTP-shaped response sent
// back to fusor.
//
// Why a separate function (instead of overloading `definePlatform`):
// switching `messages`'s shape based on the resolved type of `_Client` via a
// conditional type breaks TS contextual typing of the `({ client, config })`
// parameter for non-fusor providers (Slack/iMessage `_Client` is a union or
// branded type; the conditional collapses to `unknown` before `_Client`
// resolves). Keeping the two entrypoints separate sidesteps the inference
// race and gives each call site clean parameter types.
export function defineFusorPlatform<
  _Name extends string,
  _ConfigSchema extends z.ZodType<object>,
  _UserSchema extends z.ZodType<object> | undefined,
  _SpaceSchema extends z.ZodType<object> | undefined,
  _SpaceParamsSchema extends z.ZodType<object> | undefined,
  _TPayload,
  _ResolvedUser extends { id: string },
  _ResolvedSpace extends { id: string },
  _MessageSchema extends z.ZodType<object> | undefined = undefined,
  _Static extends Record<string, unknown> = Record<never, never>,
  _SpaceActions extends Record<string, SpaceActionFn> = Record<never, never>,
  _MessageActions extends Record<string, MessageActionFn> = Record<
    never,
    never
  >,
>(
  name: _Name,
  def: {
    config: _ConfigSchema;
    lifecycle: {
      createClient: (
        ctx: CreateClientContext<_ConfigSchema>
      ) => Promise<FusorClient<_TPayload>>;
      destroyClient?: (ctx: {
        client: FusorClient<_TPayload>;
        store: Store;
      }) => Promise<void>;
    };
    user: {
      schema?: _UserSchema;
      resolve: (_: {
        input: { userID: string };
        client: FusorClient<_TPayload>;
        config: z.infer<_ConfigSchema>;
        store: Store;
      }) => Promise<_ResolvedUser>;
    };
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
        client: FusorClient<_TPayload>;
        config: z.infer<_ConfigSchema>;
        store: Store;
      }) => Promise<_ResolvedSpace>;
      actions?: _SpaceActions;
    };
    message?: {
      schema?: _MessageSchema;
      actions?: _MessageActions;
    };
    messages: FusorMessages<_TPayload>;
    send: (_: {
      space: _ResolvedSpace & { id: string; __platform: _Name };
      content: Content;
      client: FusorClient<_TPayload>;
      config: z.infer<_ConfigSchema>;
      store: Store;
    }) => Promise<ProviderMessageRecord | undefined>;
    actions?: {
      getMessage?: (_: {
        space: _ResolvedSpace & { id: string; __platform: _Name };
        messageId: string;
        client: FusorClient<_TPayload>;
        config: z.infer<_ConfigSchema>;
        store: Store;
      }) => Promise<unknown>;
    };
    static?: _Static;
  }
): Platform<
  PlatformDef<
    _Name,
    _ConfigSchema,
    _UserSchema,
    _SpaceSchema,
    _SpaceParamsSchema,
    FusorClient<_TPayload>,
    _ResolvedUser,
    _ResolvedSpace,
    _MessageSchema,
    ProviderMessage<
      _ResolvedUser,
      _ResolvedSpace,
      _MessageSchema extends z.ZodType<object>
        ? z.infer<_MessageSchema>
        : Record<never, never>
    >,
    undefined,
    _SpaceActions,
    _MessageActions
  >
> &
  Readonly<_Static> {
  // `messages` is typed as `FusorMessages<TPayload>` at the call-site, but the
  // stored PlatformDef shape uses the unified `EventProducer<...>` type.
  // FusorCore reads `messages` directly off `__definition` at runtime and
  // invokes it with `{ payload, respond }`, so the cast is safe.
  return definePlatform(
    name,
    def as unknown as Parameters<typeof definePlatform>[1]
  ) as unknown as Platform<
    PlatformDef<
      _Name,
      _ConfigSchema,
      _UserSchema,
      _SpaceSchema,
      _SpaceParamsSchema,
      FusorClient<_TPayload>,
      _ResolvedUser,
      _ResolvedSpace,
      _MessageSchema,
      ProviderMessage<
        _ResolvedUser,
        _ResolvedSpace,
        _MessageSchema extends z.ZodType<object>
          ? z.infer<_MessageSchema>
          : Record<never, never>
      >,
      undefined,
      _SpaceActions,
      _MessageActions
    >
  > &
    Readonly<_Static>;
}
