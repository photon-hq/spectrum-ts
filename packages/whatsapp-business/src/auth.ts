import {
  createClient,
  type SubscribeOptions,
  TypedEventStream,
  type WhatsAppClient,
  type WhatsAppEvent,
} from "@photon-ai/whatsapp-business";
import { cloud, stream } from "@spectrum-ts/core";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";

const log = createLogger("spectrum.whatsapp.auth");
const streamLog = createLogger("spectrum.whatsapp.stream");

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const RESUBSCRIBE_BACKOFF_MS = 500;

const ignoreCleanupError = () => undefined;

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
  let refreshFailures = 0;
  let refreshInFlight: Promise<void> | undefined;

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

  const onRefreshSuccess = () => {
    if (refreshFailures > 0) {
      log.info("whatsapp token refresh recovered", {
        "spectrum.whatsapp.auth.attempt": refreshFailures,
      });
      refreshFailures = 0;
    }
  };

  const onRefreshFailure = (error: unknown) => {
    refreshFailures += 1;
    log.warn(
      "whatsapp token refresh failed; retrying",
      {
        "spectrum.whatsapp.auth.attempt": refreshFailures,
        "spectrum.whatsapp.auth.retry_in_ms": RETRY_DELAY_MS,
        ...errorAttrs(error),
      },
      error
    );
  };

  const clearRenewalTimer = () => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  const refreshNow = async (): Promise<void> => {
    await refreshTokens();
    onRefreshSuccess();
    scheduleRenewal();
  };

  const coalescedRefresh = (): Promise<void> => {
    if (!refreshInFlight) {
      refreshInFlight = refreshNow().finally(() => {
        refreshInFlight = undefined;
      });
    }
    return refreshInFlight;
  };

  const scheduleRenewal = () => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const ttlMs = tokenData.expiresIn * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

    const runScheduledRefresh = () => {
      coalescedRefresh().catch((err) => {
        onRefreshFailure(err);
        if (disposed) {
          return;
        }
        renewalTimer = setTimeout(runScheduledRefresh, RETRY_DELAY_MS);
        renewalTimer?.unref?.();
      });
    };

    renewalTimer = setTimeout(runScheduledRefresh, renewInMs);
    renewalTimer?.unref?.();
  };

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    await coalescedRefresh();
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
  isClosed: () => boolean;
  options?: SubscribeOptions;
  setActive: (stream: TypedEventStream<WhatsAppEvent> | undefined) => void;
  swapVersion: () => number;
  waitForSwap: (version: number) => Promise<void>;
}

type PumpResult = "closed" | "ended" | "error" | "swap";

type NextResult =
  | { type: "next"; result: IteratorResult<WhatsAppEvent> }
  | { type: "error"; error: unknown };

const settleNext = (
  next: Promise<IteratorResult<WhatsAppEvent>>
): Promise<NextResult> =>
  next.then(
    (result) => ({ type: "next", result }),
    (error) => ({ type: "error", error })
  );

const closeStream = (stream: TypedEventStream<WhatsAppEvent>): void => {
  stream.close().catch(ignoreCleanupError);
};

const returnIterator = (iterator: AsyncIterator<WhatsAppEvent>): void => {
  iterator.return?.(undefined).catch(ignoreCleanupError);
};

const pumpOnce = async (ctx: ResubscribeContext): Promise<PumpResult> => {
  const sub = ctx.getCurrent().events.subscribe(ctx.options);
  const iterator = sub[Symbol.asyncIterator]();
  const swapVersion = ctx.swapVersion();
  ctx.setActive(sub);
  try {
    while (!ctx.isClosed()) {
      const result = await Promise.race([
        settleNext(iterator.next()),
        ctx.waitForSwap(swapVersion).then(() => ({ type: "swap" as const })),
      ]);

      if (result.type === "swap") {
        closeStream(sub);
        returnIterator(iterator);
        return ctx.isClosed() ? "closed" : "swap";
      }

      if (result.type === "error") {
        throw result.error;
      }

      if (result.result.done) {
        return ctx.isClosed() ? "closed" : "ended";
      }

      await ctx.emit(result.result.value);
    }
    return "closed";
  } catch (error) {
    closeStream(sub);
    returnIterator(iterator);
    streamLog.warn(
      "whatsapp event stream interrupted; resubscribing",
      {
        "spectrum.whatsapp.resubscribe_in_ms": RESUBSCRIBE_BACKOFF_MS,
        ...errorAttrs(error),
      },
      error
    );
    return ctx.isClosed() ? "closed" : "error";
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
  let swapVersion = 0;
  let wakeSwap: (() => void) | undefined;

  const wake = () => {
    wakeSwap?.();
    wakeSwap = undefined;
  };

  const requestResubscribe = () => {
    swapVersion += 1;
    wake();
    active?.close().catch(ignoreCleanupError);
  };

  const source = stream<WhatsAppEvent>((emit, end) => {
    const ctx: ResubscribeContext = {
      emit,
      getCurrent: () => state.current,
      isClosed: () => closed,
      options,
      setActive: (s) => {
        active = s;
      },
      swapVersion: () => swapVersion,
      waitForSwap: (version) => {
        if (closed || swapVersion !== version) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          wakeSwap = resolve;
        });
      },
    };
    const pump = (async () => {
      while (!closed) {
        const result = await pumpOnce(ctx);
        if (!closed && result !== "swap") {
          await new Promise((r) => setTimeout(r, RESUBSCRIBE_BACKOFF_MS));
        }
      }
      end();
    })();

    return async () => {
      closed = true;
      wake();
      active?.close().catch(ignoreCleanupError);
      active = undefined;
      state.subscriptions.delete(subscription);
      await pump;
    };
  });

  const subscription: LineSubscription = {
    close: () => {
      closed = true;
      wake();
      active?.close().catch(ignoreCleanupError);
    },
    swap: () => {
      // Force the worker loop to start a fresh RPC against state.current even
      // if the SDK iterator is stuck waiting for its old stream to finish.
      requestResubscribe();
    },
  };
  state.subscriptions.add(subscription);

  return new TypedEventStream<WhatsAppEvent>(source, async () => {
    closed = true;
    wake();
    active?.close().catch(ignoreCleanupError);
    state.subscriptions.delete(subscription);
    await source.close();
  });
};
