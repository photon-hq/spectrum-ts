import {
  createClient,
  type SubscribeOptions,
  TypedEventStream,
  type WhatsAppClient,
  type WhatsAppEvent,
} from "@photon-ai/whatsapp-business";
import { cloud, stream } from "@spectrum-ts/core";
import {
  createLogger,
  createTokenRenewal,
  errorAttrs,
} from "@spectrum-ts/core/authoring";
import {
  clearLineObservers,
  notifyLineAttached,
  notifyLineDetached,
  setLineId,
} from "./lines";

const streamLog = createLogger("spectrum.whatsapp.stream");
const authLog = createLogger("spectrum.whatsapp.auth");

const RESUBSCRIBE_BACKOFF_MS = 500;

const lineAttrs = (phoneNumberId: string) => ({
  "spectrum.whatsapp.line": phoneNumberId,
});

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

  const lines = new Map<string, LineState>();
  // This array object is never replaced — only `push`/`splice`. Callers read it
  // live, and the cloud-auth state is keyed by its identity.
  const clients: WhatsAppClient[] = [];
  // phoneNumberId -> the public proxy, so a refresh can tell an existing line
  // from a newly provisioned one.
  const records = new Map<string, WhatsAppClient>();

  const buildRawClient = (phoneNumberId: string): WhatsAppClient => {
    const accessToken = tokenData.auth[phoneNumberId];
    if (!accessToken) {
      throw new Error(
        `WhatsApp Business line ${phoneNumberId} missing from token response`
      );
    }
    return createClient({ accessToken, appSecret: "", phoneNumberId });
  };

  const attachLine = (phoneNumberId: string): void => {
    const state: LineState = {
      current: buildRawClient(phoneNumberId),
      subscriptions: new Set(),
    };
    lines.set(phoneNumberId, state);
    const proxy = buildClientProxy(state, renewal.refreshIfNeeded);
    setLineId(proxy, phoneNumberId);
    records.set(phoneNumberId, proxy);
    clients.push(proxy);
    // Synchronous, and adjacent to the push, so an observer can never see a
    // half-applied array.
    notifyLineAttached(clients, proxy);
  };

  // Detach the stream before closing the line: the proxy's close tears down its
  // subscriptions and underlying client. Never awaited by the refresh — a
  // wedged close must not stall token renewal.
  const retire = async (proxy: WhatsAppClient): Promise<void> => {
    await Promise.allSettled(notifyLineDetached(clients, proxy));
    await proxy.close();
  };

  const removeMissing = (auth: Record<string, string>): number => {
    let removed = 0;
    for (const [phoneNumberId, proxy] of records) {
      if (auth[phoneNumberId]) {
        continue;
      }
      records.delete(phoneNumberId);
      lines.delete(phoneNumberId);
      const index = clients.indexOf(proxy);
      if (index >= 0) {
        clients.splice(index, 1);
      }
      removed += 1;
      retire(proxy).catch((error: unknown) => {
        authLog.warn(
          "failed to retire whatsapp line",
          { ...lineAttrs(phoneNumberId), ...errorAttrs(error) },
          error instanceof Error ? error : undefined
        );
      });
    }
    return removed;
  };

  /**
   * Brings the client set in line with the token payload, which is the only
   * line inventory the cloud exposes: keys present but untracked are newly
   * provisioned, tracked keys that vanished were deprovisioned.
   *
   * An empty payload means the project has no lines, not that the response is
   * suspect — keeping entries the payload no longer covers would leave the
   * client routing through lines whose tokens have stopped being refreshed. A
   * genuinely malformed payload (no `auth` at all) throws instead, which the
   * caller contains before any line is removed.
   */
  const reconcile = (auth: Record<string, string>): void => {
    const next = Object.keys(auth);
    const removed = removeMissing(auth);
    let added = 0;
    for (const phoneNumberId of next) {
      const existing = records.get(phoneNumberId);
      if (existing) {
        // Re-assert the subscription rather than assuming it survived. The
        // stream layer drops a line whose stream died, and attaching is
        // idempotent, so this is what revives it — otherwise a dropped line
        // would stay dark for the life of the process.
        notifyLineAttached(clients, existing);
        continue;
      }
      attachLine(phoneNumberId);
      added += 1;
    }
    if (added > 0 || removed > 0) {
      authLog.info("whatsapp lines reconciled", {
        "spectrum.whatsapp.lines.added": added,
        "spectrum.whatsapp.lines.removed": removed,
        "spectrum.whatsapp.lines.total": clients.length,
      });
    }
  };

  const refreshTokens = async (): Promise<void> => {
    tokenData = await cloud.issueWhatsappBusinessTokens(
      projectId,
      projectSecret
    );

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

    try {
      reconcile(tokenData.auth);
    } catch (error) {
      // Rejecting here would leave the renewal's expiry unadvanced, and
      // `refreshIfNeeded` runs before every RPC, so every call on every line
      // would then re-enter the refresh. Reconcile failures stay contained.
      authLog.error(
        "whatsapp line reconcile failed",
        errorAttrs(error),
        error instanceof Error ? error : undefined
      );
    }
  };

  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "whatsapp",
    refresh: refreshTokens,
  });

  // Startup is the same reconcile against an empty set, so there is one code
  // path building lines.
  reconcile(tokenData.auth);

  cloudAuthState.set(clients, {
    dispose: async () => {
      renewal.dispose();
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
  clearLineObservers(clients);
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
