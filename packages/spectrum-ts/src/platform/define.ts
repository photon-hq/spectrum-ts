import { withSpan } from "@photon-ai/otel";
import type z from "zod";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import { UnsupportedError } from "../utils/errors";
import { classifyIdentifier as classifySingle } from "../utils/identifier";
import type { Store } from "../utils/store";
import {
  buildSpace,
  PLATFORM_WISE_ACTION_KEYS,
  warnReservedAction,
} from "./build";
import type {
  AnyPlatformDef,
  CreateClientContext,
  EventProducer,
  InstanceActionFn,
  MessageActionFn,
  Platform,
  PlatformDef,
  PlatformInstance,
  PlatformMessage,
  PlatformProviderConfig,
  PlatformRuntime,
  PlatformSpace,
  PlatformUser,
  PlatformWiseActionKey,
  ProviderMessage,
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

type RawActionFactory = (
  ctx: { client: unknown; config: unknown; store: Store },
  ...rest: unknown[]
) => Promise<unknown>;

// Build the per-instance action map for one platform. Splits `def.actions`
// into the two tiers and dispatches each entry accordingly:
//
// - **Platform-wise** (`PLATFORM_WISE_ACTION_KEYS`) — wired on every
//   instance. Calls the provider's override if declared, else falls back
//   to a default that throws `UnsupportedError`.
// - **Platform-specific** — wired only when declared. Reserved-name
//   collisions emit a warning and are skipped.
//
// Both tiers receive `{ client, config, store }` as the first arg before
// the user-supplied trailing args.
function buildInstanceActions(
  platformName: string,
  declared: Record<string, RawActionFactory> | undefined,
  reservedKeys: ReadonlySet<string>,
  buildCtx: () => { client: unknown; config: unknown; store: Store }
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const key of PLATFORM_WISE_ACTION_KEYS) {
    const override = declared?.[key];
    if (override && typeof override === "function") {
      out[key] = (...args: unknown[]) => override(buildCtx(), ...args);
    } else {
      out[key] = () => {
        throw UnsupportedError.action(key, platformName);
      };
    }
  }

  if (!declared) {
    return out;
  }
  for (const [name, factory] of Object.entries(declared)) {
    if (PLATFORM_WISE_ACTION_KEYS.has(name as PlatformWiseActionKey)) {
      continue;
    }
    if (reservedKeys.has(name)) {
      warnReservedAction("instance", name, platformName);
      continue;
    }
    if (typeof factory !== "function") {
      continue;
    }
    out[name] = (...args: unknown[]) => factory(buildCtx(), ...args);
  }
  return out;
}

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

  // Project `PlatformDef.actions` onto the platform instance via the helper
  // above. See `buildInstanceActions` for the two-tier semantics.
  const instanceActions = buildInstanceActions(
    def.name,
    (def as { actions?: Record<string, RawActionFactory> }).actions,
    new Set<string>([
      "user",
      "space",
      "messages",
      ...Object.keys(customEvents),
    ]),
    () => ({
      client: runtime.client,
      config: runtime.config,
      store: runtime.store,
    })
  );

  // Spread order: actions first, events last — an event stream cannot be
  // silently shadowed by an action of the same name (the reserved-key check
  // above already skips such actions, so this is belt-and-braces).
  return Object.assign(
    base,
    instanceActions,
    eventProperties
  ) as PlatformInstance<Def>;
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
  _Actions extends Record<string, InstanceActionFn> = Record<never, never>,
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
      _MessageActions,
      _Actions
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
    _MessageActions,
    _Actions
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
    _MessageActions,
    _Actions
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
