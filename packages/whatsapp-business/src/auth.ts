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
// Failed-renewal retry: exponential backoff from BASE, capped at MAX, with
// half-jitter. Backoff keeps a sustained cloud outage from turning every
// project into a 30s retry storm; jitter stops all projects from retrying in
// lockstep (thundering herd). The token is already expired during an outage,
// so the only cost of backing off is up to MAX of extra recovery latency.
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 120_000;
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
  let refreshFailures = 0;
  // Coalesces the timer-driven renewal and the per-RPC lazy refresh so the two
  // can never run concurrent token swaps (racing client rebuilds / leaked
  // clients). Cleared when the in-flight refresh settles.
  let inFlightRefresh: Promise<void> | undefined;

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

  const doRefresh = async (): Promise<void> => {
    const next = await cloud.issueWhatsappBusinessTokens(
      projectId,
      projectSecret
    );
    // Bail if disposed while the token request was in flight — otherwise we'd
    // build clients that dispose() already finished closing (it snapshots the
    // line set) and they would leak, never being closed.
    if (disposed) {
      return;
    }
    tokenData = next;
    tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;

    for (const [phoneNumberId, state] of lines) {
      if (!tokenData.auth[phoneNumberId]) {
        // The refreshed response no longer carries this line, so we cannot
        // rebuild its client — the existing one keeps running on a token that
        // will expire, and its event stream goes quiet with no other signal.
        // Surface it rather than dropping it silently.
        log.warn(
          "whatsapp line missing from refreshed token response; keeping existing client (its stream may stop until the line returns)",
          { "spectrum.whatsapp.auth.phone_number_id": phoneNumberId }
        );
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

  // Single-flight wrapper: concurrent callers share one refresh instead of
  // issuing racing token swaps.
  const refreshTokens = (): Promise<void> => {
    if (!inFlightRefresh) {
      inFlightRefresh = doRefresh().finally(() => {
        inFlightRefresh = undefined;
      });
    }
    return inFlightRefresh;
  };

  const onRefreshSuccess = () => {
    if (refreshFailures > 0) {
      log.info("whatsapp token refresh recovered", {
        "spectrum.whatsapp.auth.attempt": refreshFailures,
      });
      refreshFailures = 0;
    }
  };

  // Exponential backoff with half-jitter, from the already-incremented failure
  // count. E.g. ~15–30s, ~30–60s, ~60–120s, then capped at ~60–120s.
  const nextRetryDelayMs = (): number => {
    const exp = Math.min(
      RETRY_BASE_MS * 2 ** (refreshFailures - 1),
      RETRY_MAX_MS
    );
    return Math.round(exp * (0.5 + Math.random() * 0.5));
  };

  const onRefreshFailure = (error: unknown): number => {
    refreshFailures += 1;
    const retryInMs = nextRetryDelayMs();
    log.warn(
      "whatsapp token refresh failed; retrying",
      {
        "spectrum.whatsapp.auth.attempt": refreshFailures,
        "spectrum.whatsapp.auth.retry_in_ms": retryInMs,
        ...errorAttrs(error),
      },
      error
    );
    return retryInMs;
  };

  const clearRenewalTimer = () => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  // One renewal attempt. On success, schedule the next at the TTL ratio; on
  // failure, RETRY the refresh itself after a jittered backoff. The old code
  // rescheduled scheduleRenewal() on failure, which waited another full
  // ~0.8×TTL against the STALE expiry before trying again — so a single 500
  // from cloud left the token to expire and the stream silent for ~12 minutes.
  const runRenewal = async (): Promise<void> => {
    try {
      await refreshTokens();
      onRefreshSuccess();
      scheduleRenewal();
    } catch (err) {
      const retryInMs = onRefreshFailure(err);
      if (disposed) {
        return;
      }
      clearRenewalTimer();
      renewalTimer = setTimeout(runRenewal, retryInMs);
      renewalTimer?.unref?.();
    }
  };

  const scheduleRenewal = () => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const ttlMs = tokenData.expiresIn * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

    renewalTimer = setTimeout(runRenewal, renewInMs);
    renewalTimer?.unref?.();
  };

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    await refreshTokens();
    onRefreshSuccess();
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
  } catch (error) {
    streamLog.warn(
      "whatsapp event stream interrupted; resubscribing",
      {
        "spectrum.whatsapp.resubscribe_in_ms": RESUBSCRIBE_BACKOFF_MS,
        ...errorAttrs(error),
      },
      error
    );
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
