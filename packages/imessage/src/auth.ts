import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import {
  cloud,
  type DedicatedTokenData,
  type LinesData,
  type SharedTokenData,
  type SpectrumLike,
} from "@spectrum-ts/core";
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
import { IMESSAGE_PLATFORM } from "./platform";
import { type RemoteClient, SHARED_PHONE } from "./types";

// Floor between forced re-mints so a stream reconnect storm can't hammer the
// cloud token endpoint — well below any token TTL, just enough to coalesce the
// message + poll streams asking at nearly the same instant.
const FORCE_REFRESH_MIN_INTERVAL_MS = 5000;

// How often line discovery compares the cloud's line inventory against the
// tracked client set. A matching inventory costs one authenticated GET and no
// re-mint; drift triggers the same refresh the renewal timer runs.
const DEFAULT_LINE_DISCOVERY_INTERVAL_MS = 60_000;

// A drift that survives its own re-mint cannot be resolved by minting again
// right away — e.g. a line the token service skips because its instance is
// not resolvable yet, or stale entries after a plan change. Retry such a
// drift only every Nth tick, so a wedged line costs one mint per damp window
// instead of one per poll, while a NEW drift still re-mints immediately.
const REPEAT_DRIFT_DAMP_TICKS = 5;

const authLog = createLogger("spectrum.imessage.auth");

export interface LineDiscoveryOptions {
  /** Set `false` to turn the inventory poll off entirely. */
  enabled?: boolean;
  /** Poll cadence; defaults to 60 seconds. */
  intervalMs?: number;
}

export interface CloudClientOptions {
  lineDiscovery?: LineDiscoveryOptions;
}

interface CloudAuth {
  dispose: () => void;
  forceRefresh: () => Promise<void>;
  refreshLines: () => Promise<void>;
}

const cloudAuthState = new WeakMap<RemoteClient[], CloudAuth>();

const instanceAttrs = (instanceId: string) => ({
  "spectrum.imessage.instance": instanceId,
});

// The polled inventory reduced to the phone set discovery diffs against.
const listedImessagePhones = (data: LinesData): Set<string> => {
  const listed = new Set<string>();
  for (const line of data.lines) {
    if (line.platform === "imessage") {
      listed.add(line.phoneNumber);
    }
  }
  return listed;
};

export async function createCloudClients(
  projectId: string,
  projectSecret: string,
  options?: CloudClientOptions
): Promise<RemoteClient[]> {
  let tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
  let lastRefreshAt = Date.now();

  // This array object is never replaced — only `push`/`splice`. Routing helpers
  // read it live on every call, and three WeakMaps (cloud auth, poll cache,
  // profile-sync gate) plus core's own platform state are keyed by its identity,
  // so swapping it in would silently orphan all of them.
  const entries: RemoteClient[] = [];
  // instanceId -> entry, so a refresh can tell an existing line from a newly
  // provisioned one without leaking instanceId onto the public shape.
  const records = new Map<string, RemoteClient>();

  const buildEntry = (
    instanceId: string,
    phone: string,
    initialToken: string
  ): RemoteClient => ({
    phone,
    client: createGrpcClient({
      address: `${instanceId}.imsg.photon.codes:443`,
      autoIdempotency: true,
      retry: true,
      tls: true,
      token: async () => {
        await renewal.refreshIfNeeded();
        // Narrowed, not asserted: a refresh can in principle come back shared
        // (a plan change), where `auth` does not exist at all — reading through
        // it would reject every RPC on this line.
        if (tokenData.type !== "dedicated") {
          return initialToken;
        }
        return tokenData.auth[instanceId] ?? initialToken;
      },
    }),
  });

  // Detach the stream before closing the channel: closing it under a live
  // subscription produces a reconnect-warn storm until the detach lands. Never
  // awaited by `refresh` — a wedged channel must not stall token renewal.
  const retire = async (entry: RemoteClient): Promise<void> => {
    await Promise.allSettled(notifyLineDetached(entries, entry));
    await entry.client.close();
  };

  const removeMissing = (data: DedicatedTokenData): number => {
    let removed = 0;
    for (const [instanceId, entry] of records) {
      if (data.auth[instanceId]) {
        continue;
      }
      records.delete(instanceId);
      const index = entries.indexOf(entry);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      removed += 1;
      retire(entry).catch((error: unknown) => {
        authLog.warn(
          "failed to retire imessage line",
          { ...instanceAttrs(instanceId), ...errorAttrs(error) },
          error instanceof Error ? error : undefined
        );
      });
    }
    return removed;
  };

  const addOrSync = (data: DedicatedTokenData): number => {
    let added = 0;
    for (const [instanceId, token] of Object.entries(data.auth)) {
      const phone = data.numbers?.[instanceId];
      const existing = records.get(instanceId);
      if (existing) {
        if (phone) {
          existing.phone = phone;
        } else {
          authLog.warn(
            "imessage line lost its phone number; keeping the last known number",
            instanceAttrs(instanceId)
          );
        }
        // Re-assert the subscription rather than assuming it survived. The
        // stream layer drops a line whose stream died, and attaching is
        // idempotent, so this is what revives it — otherwise a dropped line
        // would stay dark for the life of the process.
        notifyLineAttached(entries, existing);
        continue;
      }
      if (!phone) {
        // A line can exist before a number is assigned to it. Skipping keeps
        // startup alive and lets a later refresh pick the line up, where the
        // old behavior threw and took the whole client down with it.
        authLog.warn(
          "skipping imessage line without a phone number",
          instanceAttrs(instanceId)
        );
        continue;
      }
      const entry = buildEntry(instanceId, phone, token);
      setLineId(entry, instanceId);
      records.set(instanceId, entry);
      entries.push(entry);
      // Synchronous, and adjacent to the push, so an observer can never see a
      // half-applied array.
      notifyLineAttached(entries, entry);
      added += 1;
    }
    return added;
  };

  /**
   * Brings the client set in line with the token payload, which is the only
   * inventory the cloud exposes: keys present but untracked are newly
   * provisioned, tracked keys that vanished were deprovisioned.
   *
   * An empty payload means the project has no lines, not that the response is
   * suspect — keeping entries the payload no longer covers would leave the
   * client routing through channels whose tokens have stopped being refreshed.
   * A genuinely malformed payload (no `auth` at all) throws instead, which the
   * caller contains before any line is removed.
   */
  const reconcile = (data: DedicatedTokenData): void => {
    const removed = removeMissing(data);
    const added = addOrSync(data);
    if (added > 0 || removed > 0) {
      authLog.info("imessage lines reconciled", {
        "spectrum.imessage.lines.added": added,
        "spectrum.imessage.lines.removed": removed,
        "spectrum.imessage.lines.total": entries.length,
      });
    }
  };

  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
      lastRefreshAt = Date.now();
      if (tokenData.type !== "dedicated") {
        return;
      }
      try {
        reconcile(tokenData);
      } catch (error) {
        // Rejecting here would leave the renewal's expiry unadvanced, and since
        // `refreshIfNeeded` runs on every RPC, every call on every line would
        // then re-enter the refresh. Reconcile failures stay contained.
        authLog.error(
          "imessage line reconcile failed",
          errorAttrs(error),
          error instanceof Error ? error : undefined
        );
      }
    },
  });

  // Re-mint unconditionally — wired to the stream recover hook so a token the
  // server rejects after a restart (UNAUTHENTICATED / "Invalid credentials",
  // not yet near expiry) is replaced. The per-RPC token function then hands the
  // fresh token to the next reconnect without recreating the gRPC channel.
  const forceRefresh = async (): Promise<void> => {
    if (Date.now() - lastRefreshAt < FORCE_REFRESH_MIN_INTERVAL_MS) {
      return;
    }
    await renewal.forceRefresh();
  };

  // Poll the cloud's line inventory and re-mint when it drifts from the
  // tracked set, so a line provisioned mid-run attaches within one poll
  // interval instead of at the next scheduled renewal (80% of the token TTL).
  // Compares phone numbers, not line ids: reconcile skips a line that has no
  // number yet, so an id-based diff would re-mint every tick for a line that
  // cannot attach. The poll only reads; the re-mint stays the single path that
  // mutates the client set.
  // Discovery is best-effort by contract: nothing in here may throw out of
  // the interval, mutate the client set directly (only reconcile does that),
  // or run once the client is disposed. Every failure mode degrades to the
  // pre-discovery behavior — the line is picked up at the next token renewal.
  const startLineDiscovery = (): (() => void) | undefined => {
    if (options?.lineDiscovery?.enabled === false) {
      return;
    }
    const intervalMs =
      options?.lineDiscovery?.intervalMs ?? DEFAULT_LINE_DISCOVERY_INTERVAL_MS;
    let pollInFlight = false;
    let pollFailures = 0;
    let lastDriftSignature: string | undefined;
    let ticksSinceDriftMint = 0;

    const noteRecovered = (): void => {
      if (pollFailures === 0) {
        return;
      }
      authLog.info("imessage line discovery poll recovered", {
        "spectrum.imessage.discovery.failures": pollFailures,
      });
      pollFailures = 0;
    };

    // The damp gate: a NEW drift signature mints immediately; the same one
    // persisting across ticks mints only once per damp window.
    const shouldMintForDrift = (signature: string): boolean => {
      if (signature === lastDriftSignature) {
        ticksSinceDriftMint += 1;
        if (ticksSinceDriftMint < REPEAT_DRIFT_DAMP_TICKS) {
          return false;
        }
      }
      lastDriftSignature = signature;
      ticksSinceDriftMint = 0;
      return true;
    };

    const poll = async (): Promise<void> => {
      const data = await cloud.listLines(projectId, projectSecret, "imessage");
      if (disposed) {
        return;
      }
      noteRecovered();
      const listed = listedImessagePhones(data);
      const drifted =
        listed.size !== entries.length ||
        entries.some((entry) => !listed.has(entry.phone));
      if (!drifted) {
        lastDriftSignature = undefined;
        return;
      }
      const signature = `${[...listed].sort().join(",")}|${entries
        .map((entry) => entry.phone)
        .sort()
        .join(",")}`;
      if (!shouldMintForDrift(signature)) {
        return;
      }
      authLog.info("imessage line inventory drifted; re-minting tokens", {
        "spectrum.imessage.lines.listed": listed.size,
        "spectrum.imessage.lines.tracked": entries.length,
      });
      await renewal.forceRefresh();
    };

    const timer = setInterval(() => {
      // Skip the tick rather than queue behind a slow poll or refresh — the
      // next tick re-checks the same live inventory anyway.
      if (pollInFlight || disposed) {
        return;
      }
      pollInFlight = true;
      poll()
        .catch((error: unknown) => {
          pollFailures += 1;
          // First failure of a streak at warn, the rest at debug: an outage
          // otherwise warn-logs once a minute for its whole duration, and the
          // recovery log above already brackets the streak.
          const logFailure = pollFailures === 1 ? authLog.warn : authLog.debug;
          logFailure(
            "imessage line discovery poll failed",
            {
              "spectrum.imessage.discovery.failures": pollFailures,
              ...errorAttrs(error),
            },
            error instanceof Error ? error : undefined
          );
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, intervalMs);
    timer.unref?.();

    return () => clearInterval(timer);
  };

  let disposed = false;
  let stopLineDiscovery: (() => void) | undefined;

  const cloudAuth: CloudAuth = {
    dispose: () => {
      disposed = true;
      stopLineDiscovery?.();
      renewal.dispose();
    },
    forceRefresh,
    // Deliberate calls (the public refreshLines) bypass the reconnect-storm
    // floor above — a user who just provisioned a line must never have the
    // refresh silently skipped — and chain behind an in-flight refresh
    // instead of coalescing onto it, whose payload may predate the
    // provisioning the caller is trying to pick up.
    refreshLines: () => renewal.refreshNext(),
  };

  if (tokenData.type === "shared") {
    const address =
      process.env.SPECTRUM_IMESSAGE_ADDRESS ??
      "imessage.spectrum.photon.codes:443";
    entries.push({
      phone: SHARED_PHONE,
      client: createGrpcClient({
        address,
        // Auto-retry transient unary failures so a brief server blip during
        // an outbound action (send/react/reply) doesn't surface as an
        // uncaught error. `autoIdempotency` attaches an x-idempotency-key to
        // mutating RPCs so the retry can't double-apply.
        autoIdempotency: true,
        retry: true,
        tls: true,
        token: async () => {
          await renewal.refreshIfNeeded();
          return (tokenData as SharedTokenData).token;
        },
      }),
    });

    cloudAuthState.set(entries, cloudAuth);

    return entries;
  }

  // Startup is the same reconcile against an empty set, so there is one code
  // path building lines and one place that decides what a line needs.
  reconcile(tokenData);

  // Dedicated mode only: shared-pool projects have no line inventory to watch.
  stopLineDiscovery = startLineDiscovery();

  cloudAuthState.set(entries, cloudAuth);

  return entries;
}

export async function disposeCloudAuth(clients: RemoteClient[]): Promise<void> {
  clearLineObservers(clients);
  const auth = cloudAuthState.get(clients);
  if (auth) {
    auth.dispose();
    cloudAuthState.delete(clients);
  }
}

/**
 * The recover hook for a cloud-backed client array: forces a token re-mint so a
 * persistently-failing stream (server rejecting an unexpired token after a
 * restart) gets a fresh bearer on its next reconnect. Returns undefined for
 * explicitly-configured (static-token) clients, which have nothing to re-mint.
 */
export function getCloudRecover(
  clients: RemoteClient[]
): (() => Promise<void>) | undefined {
  return cloudAuthState.get(clients)?.forceRefresh;
}

/**
 * The on-demand refresh for a cloud-backed client array: re-mints tokens
 * immediately (coalesced with an in-flight refresh, never throttled) and
 * reconciles the line set. Undefined for explicitly-configured (static-token)
 * clients, which have no cloud inventory to refresh.
 */
export function getLineRefresh(
  clients: RemoteClient[]
): (() => Promise<void>) | undefined {
  return cloudAuthState.get(clients)?.refreshLines;
}

/**
 * Re-mint `app`'s iMessage cloud credentials right now and reconcile its line
 * set, so a line provisioned (or removed) moments ago attaches without
 * waiting for the scheduled token renewal or the discovery poll. Resolves once
 * the refreshed inventory has been applied to the running client — new lines
 * are routable and subscribed when this returns.
 *
 * A no-op for explicitly-configured (`clients: [...]`) providers, which have
 * no cloud inventory to refresh. Throws when the instance has no iMessage
 * provider registered (or has already been stopped).
 */
export async function refreshLines(app: SpectrumLike): Promise<void> {
  const runtime = app.__internal.platforms.get(IMESSAGE_PLATFORM);
  if (!runtime) {
    throw new Error(
      "refreshLines: no iMessage provider is registered on this Spectrum instance (or it has been stopped)"
    );
  }
  const refresh = getLineRefresh(runtime.client as RemoteClient[]);
  if (!refresh) {
    return;
  }
  await refresh();
}
