import { createLogger, withSpan } from "@photon-ai/otel";
import type z from "zod";
import type { FusorClient, FusorMessages } from "../fusor/types";
import type { Message } from "../types/message";
import type { Space } from "../types/space";
import type { ProjectData } from "../utils/cloud";
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

const platformLog = createLogger("spectrum.platform");

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

  const providerCtx = () => ({
    client: runtime.client as _Client,
    config: runtime.config as z.infer<_ConfigSchema>,
    store: runtime.store,
  });

  const parseSpaceParams = (params: unknown): unknown =>
    params !== undefined && def.space.params
      ? def.space.params.parse(params)
      : params;

  // Schema-validate a provider-resolved space and wrap it as a full
  // PlatformSpace (spaceRef + universal sugar via buildSpace).
  const finalizeSpace = (resolved: { id: string }): PlatformSpace<Def> => {
    const parsedSpace = (
      def.space.schema ? def.space.schema.parse(resolved) : resolved
    ) as { id: string };
    const spaceRef = {
      ...(parsedSpace as Record<string, unknown>),
      id: parsedSpace.id,
      __platform: def.name,
    };
    const actionCtx = {
      space: spaceRef,
      ...providerCtx(),
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
  };

  const base = {
    async user(userID: string) {
      return await resolveUserID(userID);
    },

    space: {
      create: async (
        users: PlatformUser<Def> | string | (PlatformUser<Def> | string)[],
        params?: unknown
      ): Promise<PlatformSpace<Def>> => {
        const userList = Array.isArray(users) ? users : [users];
        const first = userList.length === 1 ? userList[0] : undefined;
        const single =
          typeof first === "string" ? classifySingle(first) : undefined;
        const kind =
          userList.length > 1 ? "group" : (single?.kind ?? "unknown");
        return await withSpan(
          "spectrum.space.create",
          {
            "spectrum.provider": def.name,
            "spectrum.space.user_count": userList.length,
            "spectrum.space.identifier_kind": kind,
            "spectrum.space.identifier":
              kind === "unknown" ? undefined : single?.identifier,
          },
          async () => {
            const resolvedUsers = await Promise.all(
              userList.map((u) =>
                typeof u === "string" ? resolveUserID(u) : u
              )
            );
            const resolved = await def.space.create({
              input: { users: resolvedUsers, params: parseSpaceParams(params) },
              ...providerCtx(),
            });
            return finalizeSpace(resolved);
          }
        );
      },

      get: async (id: string, params?: unknown): Promise<PlatformSpace<Def>> =>
        await withSpan(
          "spectrum.space.get",
          {
            "spectrum.provider": def.name,
            "spectrum.space.id": id,
          },
          async () => {
            const parsedParams = parseSpaceParams(params);
            if (def.space.get) {
              const resolved = await def.space.get({
                input: { id, params: parsedParams },
                ...providerCtx(),
              });
              return finalizeSpace(resolved);
            }
            // Framework default: the id alone is the space. Providers whose
            // schema needs more fields must implement `space.get`.
            const candidate = { id };
            if (def.space.schema) {
              const parsed = def.space.schema.safeParse(candidate);
              if (!parsed.success) {
                throw new Error(
                  `Platform "${def.name}" cannot construct a space from an id alone — its space schema requires more fields. Implement \`space.get\` in the "${def.name}" provider definition.`,
                  { cause: parsed.error }
                );
              }
            }
            return finalizeSpace(candidate);
          }
        ),
    },
  };

  // Add flat event properties for custom events. The core `messages` stream
  // lives at the top level of the def — only the optional `events?` slot
  // (custom platform events like presence, read receipts, etc.) is projected
  // onto the instance here.
  const eventProperties: Record<string, AsyncIterable<unknown>> = {};
  const customEvents = def.events ?? {};
  for (const eventName of Object.keys(customEvents)) {
    const declared = customEvents[eventName];
    if (typeof declared === "function") {
      // Regular platform: a producer driven by the long-lived client. Pass the
      // full EventProducer context (incl. projectConfig) so an instance-level
      // `platform.<event>` matches the top-level `spectrum.<event>` stream.
      const producer = declared as (ctx: {
        client: unknown;
        config: unknown;
        projectConfig: ProjectData | undefined;
        store: Store;
      }) => AsyncIterable<unknown>;
      eventProperties[eventName] = producer({
        client: runtime.client,
        config: runtime.config,
        projectConfig: runtime.projectConfig,
        store: runtime.store,
      });
      continue;
    }
    // Fusor platform: the channel is a Zod schema; its data arrives via the
    // `messages` handler returning `fusorEvent(eventName, data)`, buffered on a
    // per-channel queue that the runtime exposes as a fanout subscription.
    const fusorEvents = runtime.subscribeEvent?.(eventName);
    if (fusorEvents) {
      eventProperties[eventName] = fusorEvents;
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
  // Two-step cast: `messages` is wired via defineProperty above, so `base`
  // doesn't structurally satisfy PlatformInstance at the type level.
  return Object.assign(
    base,
    instanceActions,
    eventProperties
  ) as unknown as PlatformInstance<Def>;
}

// `definePlatform` has two call shapes, expressed as overloads:
//
// 1. **Fusor mode** — `lifecycle.createClient` returns `fusor(name, verify)`
//    (a branded `FusorClient<TPayload>`). There is no long-lived SDK client;
//    `messages` runs once per inbound webhook against an already-verified
//    payload, returning the message(s) to emit on `spectrum.messages` (and
//    optionally calling `respond(reply)` to shape the HTTP reply to fusor).
// 2. **Regular mode** — `createClient` returns a normal SDK client and
//    `messages` is a long-lived `EventProducer` (async-iterable) stream.
//
// Overloads (not one conditional signature): switching `messages`'s shape on
// the resolved `_Client` via a conditional type breaks TS contextual typing of
// `({ client, config })` for regular providers — the conditional collapses to
// `unknown` before `_Client` resolves. Two concrete signatures sidestep that.
//
// The REGULAR overload is listed first. Overload resolution defers
// context-sensitive (unannotated-param) arrows during applicability, so a def
// whose `createClient` and `messages` are both inline arrows — every regular
// provider — matches the first applicable overload (regular). A fusor provider
// opts in by giving `messages` a typed `FusorMessages` reference (e.g.
// telegram's `handleMessages`): that's non-context-sensitive, checked in pass 1,
// so it rejects the regular overload and selects the fusor one. The fusor input
// reuses `PlatformDef` with `_Client = FusorClient<_TPayload>` (which fixes
// every client position), overriding only `lifecycle`/`messages`.
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
  Readonly<_Static>;

export function definePlatform<
  _Name extends string,
  _ConfigSchema extends z.ZodType<object>,
  _UserSchema extends z.ZodType<object> | undefined,
  _SpaceSchema extends z.ZodType<object> | undefined,
  _SpaceParamsSchema extends z.ZodType<object> | undefined,
  _TPayload,
  _ResolvedUser extends { id: string },
  _ResolvedSpace extends { id: string },
  _MessageSchema extends z.ZodType<object> | undefined = undefined,
  // Fusor custom event channels: each value is a Zod schema; the key is the
  // channel name. Surfaced as `spectrum.<channel>` and emitted from `messages`
  // via `fusorEvent(channel, data)`. (`messages` is reserved — the core stream.)
  _FusorEvents extends
    | (Record<string, z.ZodType<object>> & { messages?: never })
    | undefined = undefined,
  _Static extends Record<string, unknown> = Record<never, never>,
  _SpaceActions extends Record<string, SpaceActionFn> = Record<never, never>,
  _MessageActions extends Record<string, MessageActionFn> = Record<
    never,
    never
  >,
>(
  name: _Name,
  def: Omit<
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
      _FusorEvents,
      _SpaceActions,
      _MessageActions
    >,
    "lifecycle" | "name" | "messages"
  > & {
    lifecycle: {
      createClient: (
        ctx: CreateClientContext<_ConfigSchema>
      ) => Promise<FusorClient<_TPayload>>;
      destroyClient?: (ctx: {
        client: FusorClient<_TPayload>;
        store: Store;
      }) => Promise<void>;
    };
    messages: FusorMessages<_TPayload, z.infer<_ConfigSchema>>;
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
    _FusorEvents,
    _SpaceActions,
    _MessageActions
  >
> &
  Readonly<_Static>;

// Implementation signature — intentionally loose so both overloads above are
// assignable to it. Callers only ever see the overloads; the body erases to
// `AnyPlatformDef` and the overload return types restore precision at the call
// site. The runtime is identical for both modes: fusor's `messages`/`events`
// are read off `__definition` by FusorCore, never invoked here.
export function definePlatform(name: string, rawDef: unknown): unknown {
  const def = rawDef as AnyPlatformDef & {
    static?: Record<string, unknown>;
  };
  type Def = AnyPlatformDef;

  const fullDef = { ...def, name };

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

    const instance = createPlatformInstance<Def, unknown, z.ZodType<object>>(
      fullDef as Def & AnyPlatformDef,
      runtime
    );
    platformCache.set(spectrum, instance);
    return instance;
  };

  const narrowSpace = (input: Space) => {
    if (input.__platform !== name) {
      platformLog.warn("space platform mismatch; narrowing skipped", {
        expected: name,
        actual: input.__platform,
      });
    }
    return input as PlatformSpace<Def>;
  };

  const narrowMessage = (input: Message) => {
    if (input.platform !== name) {
      platformLog.warn("message platform mismatch; narrowing skipped", {
        expected: name,
        actual: input.platform,
      });
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

  narrower.config = (config?: unknown) => {
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

  return narrower as Platform<Def> & Record<string, unknown>;
}
