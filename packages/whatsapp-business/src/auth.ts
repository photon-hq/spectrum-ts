import {
  createClient,
  type SubscribeOptions,
  TypedEventStream,
  type WhatsAppClient,
  type WhatsAppEvent,
} from "@photon-ai/whatsapp-business";
import { cloud, stream } from "@spectrum-ts/core";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const RESUBSCRIBE_BACKOFF_MS = 500;

interface CloudAuth {
  dispose: () => Promise<void>;
}

interface LineSubscription {
  close: () => void;
  swap: () => void;
}

interface LineState {
  current: WhatsAppClient;
  subscriptions: Set<LineSubscription>;
}

const cloudAuthState = new WeakMap<WhatsAppClient[], CloudAuth>();

// `@photon-ai/whatsapp-business` 0.1.x does not accept a token callback, so we
// recreate the underlying client before each RPC when the token is near expiry,
// and transparently re-subscribe long-lived event streams across swaps.
export async function createCloudClients(
  projectId: string,
  projectSecret: string
): Promise<WhatsAppClient[]> {
  let tokenData = await cloud.issueWhatsappBusinessTokens(
    projectId,
    projectSecret
  );
  let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;

  const lines = new Map<string, LineState>();

  const buildRawClient = (phoneNumberId: string): WhatsAppClient => {
    const accessToken = tokenData.auth[phoneNumberId];
    if (!accessToken) {
      throw new Error(
        `WhatsApp Business line ${phoneNumberId} missing from token response`
      );
    }
    return createClient({ accessToken, appSecret: "", phoneNumberId });
  };

  const refreshTokens = async (): Promise<void> => {
    tokenData = await cloud.issueWhatsappBusinessTokens(
      projectId,
      projectSecret
    );
    tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;

    for (const [phoneNumberId, state] of lines) {
      if (!tokenData.auth[phoneNumberId]) {
        continue;
      }
      const old = state.current;
      state.current = buildRawClient(phoneNumberId);
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
          `[spectrum-ts] WhatsApp Business token refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
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

  const clients: WhatsAppClient[] = Object.keys(tokenData.auth).map(
    (phoneNumberId) => {
      const state: LineState = {
        current: buildRawClient(phoneNumberId),
        subscriptions: new Set(),
      };
      lines.set(phoneNumberId, state);
      return buildClientProxy(state, refreshIfNeeded);
    }
  );

  cloudAuthState.set(clients, {
    dispose: async () => {
      disposed = true;
      clearRenewalTimer();
      for (const state of lines.values()) {
        for (const sub of state.subscriptions) {
          sub.close();
        }
      }
      await Promise.allSettled(
        Array.from(lines.values()).map((s) => s.current.close())
      );
      lines.clear();
    },
  });

  return clients;
}

export async function disposeCloudAuth(
  clients: WhatsAppClient[]
): Promise<void> {
  const auth = cloudAuthState.get(clients);
  if (!auth) {
    return;
  }
  await auth.dispose();
  cloudAuthState.delete(clients);
}

const buildClientProxy = (
  state: LineState,
  refresh: () => Promise<void>
): WhatsAppClient => {
  const forwarder = <T extends object>(pick: (c: WhatsAppClient) => T): T =>
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
    fetchMissed: async (
      opts: Parameters<WhatsAppClient["events"]["fetchMissed"]>[0]
    ) => {
      await refresh();
      return state.current.events.fetchMissed(opts);
    },
    subscribe: (options?: SubscribeOptions) =>
      resubscribableStream(state, options),
  } as unknown as WhatsAppClient["events"];

  return {
    events,
    media: forwarder((c) => c.media),
    messages: forwarder((c) => c.messages),
    close: async () => {
      for (const sub of state.subscriptions) {
        sub.close();
      }
      await state.current.close();
    },
    [Symbol.asyncDispose]: async () => {
      for (const sub of state.subscriptions) {
        sub.close();
      }
      await state.current.close();
    },
  };
};

interface ResubscribeContext {
  emit: (event: WhatsAppEvent) => Promise<void>;
  getCurrent: () => WhatsAppClient;
  options?: SubscribeOptions;
  setActive: (stream: TypedEventStream<WhatsAppEvent> | undefined) => void;
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
// `state.current`.
const resubscribableStream = (
  state: LineState,
  options?: SubscribeOptions
): TypedEventStream<WhatsAppEvent> => {
  let closed = false;
  let active: TypedEventStream<WhatsAppEvent> | undefined;

  const source = stream<WhatsAppEvent>((emit, end) => {
    const ctx: ResubscribeContext = {
      emit,
      getCurrent: () => state.current,
      options,
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

  const subscription: LineSubscription = {
    close: () => {
      closed = true;
      active?.close().catch(() => undefined);
    },
    swap: () => {
      // Force the inner for-await to end; worker loop re-subscribes to state.current.
      active?.close().catch(() => undefined);
    },
  };
  state.subscriptions.add(subscription);

  return new TypedEventStream<WhatsAppEvent>(source, async () => {
    closed = true;
    active?.close().catch(() => undefined);
    state.subscriptions.delete(subscription);
    await source.close();
  });
};
