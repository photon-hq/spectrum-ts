import {
  createClient,
  type SubscribeOptions,
  type TelegramClient,
  type TelegramEvent,
  TypedEventStream,
} from "@photon-ai/telegram";
import { cloud } from "../../utils/cloud";
import { stream } from "../../utils/stream";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const RESUBSCRIBE_BACKOFF_MS = 500;

interface CloudAuth {
  dispose: () => Promise<void>;
}

interface BotSubscription {
  close: () => void;
  swap: () => void;
}

interface BotState {
  current: TelegramClient;
  subscriptions: Set<BotSubscription>;
}

const cloudAuthState = new WeakMap<TelegramClient[], CloudAuth>();

// `@photon-ai/telegram` does not (yet) accept a token callback, so we
// recreate the underlying client when the cloud-issued credentials are near
// expiry, and transparently re-subscribe long-lived event streams across
// swaps.
export async function createCloudClients(
  projectId: string,
  projectSecret: string
): Promise<TelegramClient[]> {
  let tokenData = await cloud.issueTelegramTokens(projectId, projectSecret);
  let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;

  const bots = new Map<string, BotState>();

  const buildRawClient = (botId: string): TelegramClient => {
    const botToken = tokenData.auth[botId];
    if (!botToken) {
      throw new Error(`Telegram bot ${botId} missing from token response`);
    }
    return createClient({
      botToken,
      ...(tokenData.endpoint ? { endpoint: tokenData.endpoint } : {}),
    });
  };

  const refreshTokens = async (): Promise<void> => {
    tokenData = await cloud.issueTelegramTokens(projectId, projectSecret);
    tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;

    for (const [botId, state] of bots) {
      if (!tokenData.auth[botId]) {
        continue;
      }
      const old = state.current;
      state.current = buildRawClient(botId);
      for (const sub of state.subscriptions) {
        sub.swap();
      }
      await old.close().catch(() => undefined);
    }
  };

  const clearRenewalTimer = () => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  const scheduleRenewal = () => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const ttlMs = tokenData.expiresIn * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

    renewalTimer = setTimeout(async () => {
      try {
        await refreshTokens();
        scheduleRenewal();
      } catch (err) {
        console.warn(
          `[spectrum-ts] Telegram token refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
          err
        );
        clearRenewalTimer();
        renewalTimer = setTimeout(() => scheduleRenewal(), RETRY_DELAY_MS);
        renewalTimer?.unref?.();
      }
    }, renewInMs);
    renewalTimer?.unref?.();
  };

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    await refreshTokens();
    scheduleRenewal();
  };

  scheduleRenewal();

  const clients: TelegramClient[] = Object.keys(tokenData.auth).map((botId) => {
    const state: BotState = {
      current: buildRawClient(botId),
      subscriptions: new Set(),
    };
    bots.set(botId, state);
    return buildClientProxy(state, refreshIfNeeded);
  });

  cloudAuthState.set(clients, {
    dispose: async () => {
      disposed = true;
      clearRenewalTimer();
      for (const state of bots.values()) {
        for (const sub of state.subscriptions) {
          sub.close();
        }
      }
      await Promise.allSettled(
        Array.from(bots.values()).map((s) => s.current.close())
      );
      bots.clear();
    },
  });

  return clients;
}

export async function disposeCloudAuth(
  clients: TelegramClient[]
): Promise<void> {
  const auth = cloudAuthState.get(clients);
  if (!auth) {
    return;
  }
  await auth.dispose();
  cloudAuthState.delete(clients);
}

const buildClientProxy = (
  state: BotState,
  refresh: () => Promise<void>
): TelegramClient => {
  const forwarder = <T extends object>(pick: (c: TelegramClient) => T): T =>
    new Proxy({} as T, {
      get:
        (_, prop: string | symbol) =>
        async (...args: unknown[]) => {
          await refresh();
          const target = pick(state.current) as Record<
            string | symbol,
            unknown
          >;
          const fn = target[prop] as (...a: unknown[]) => unknown;
          return Reflect.apply(fn, pick(state.current), args);
        },
    });

  const events = {
    subscribe: (options?: SubscribeOptions) =>
      resubscribableStream(state, options),
    // `replay` is bounded and short-lived — no need for swap support; just
    // forward against the current client after refreshing.
    replay: (options: Parameters<TelegramClient["events"]["replay"]>[0]) => {
      // We can't await `refresh()` here because `replay` returns a stream
      // synchronously. The next swap will close any in-flight replay; callers
      // can retry with a new cursor.
      return state.current.events.replay(options);
    },
  } as unknown as TelegramClient["events"];

  return {
    events,
    files: forwarder((c) => c.files),
    messages: forwarder((c) => c.messages),
    close: async () => {
      for (const sub of state.subscriptions) {
        sub.close();
      }
      await state.current.close();
    },
  };
};

interface ResubscribeContext {
  emit: (event: TelegramEvent) => Promise<void>;
  getCurrent: () => TelegramClient;
  options?: SubscribeOptions;
  setActive: (stream: TypedEventStream<TelegramEvent> | undefined) => void;
}

const pumpOnce = async (ctx: ResubscribeContext): Promise<boolean> => {
  const sub = ctx.getCurrent().events.subscribe(ctx.options);
  ctx.setActive(sub);
  try {
    for await (const event of sub) {
      await ctx.emit(event);
    }
    return true;
  } catch {
    return false;
  } finally {
    ctx.setActive(undefined);
  }
};

// Returns a TypedEventStream that stays open across client swaps: on swap we
// close the underlying subscription and the worker loop re-subscribes against
// `state.current`. Cursor checkpointing is the SDK's responsibility (callers
// pass `fromCursor` via options).
const resubscribableStream = (
  state: BotState,
  options?: SubscribeOptions
): TypedEventStream<TelegramEvent> => {
  let closed = false;
  let active: TypedEventStream<TelegramEvent> | undefined;

  const source = stream<TelegramEvent>((emit, end) => {
    const ctx: ResubscribeContext = {
      emit,
      getCurrent: () => state.current,
      ...(options ? { options } : {}),
      setActive: (s) => {
        active = s;
      },
    };
    const pump = (async () => {
      while (!closed) {
        await pumpOnce(ctx);
        if (!closed) {
          await new Promise((r) => setTimeout(r, RESUBSCRIBE_BACKOFF_MS));
        }
      }
      end();
    })();

    return async () => {
      closed = true;
      active?.close().catch(() => undefined);
      active = undefined;
      state.subscriptions.delete(subscription);
      await pump;
    };
  });

  const subscription: BotSubscription = {
    close: () => {
      closed = true;
      active?.close().catch(() => undefined);
    },
    swap: () => {
      active?.close().catch(() => undefined);
    },
  };
  state.subscriptions.add(subscription);

  return new TypedEventStream<TelegramEvent>(source, async () => {
    closed = true;
    active?.close().catch(() => undefined);
    state.subscriptions.delete(subscription);
    await source.close();
  });
};
