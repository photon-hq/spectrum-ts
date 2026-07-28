import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
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
import { type RemoteClient, SHARED_PHONE } from "./types";

// Floor between forced re-mints so a stream reconnect storm can't hammer the
// cloud token endpoint — well below any token TTL, just enough to coalesce the
// message + poll streams asking at nearly the same instant.
const FORCE_REFRESH_MIN_INTERVAL_MS = 5000;

const authLog = createLogger("spectrum.imessage.auth");

interface CloudAuth {
  dispose: () => void;
  forceRefresh: () => Promise<void>;
}

const cloudAuthState = new WeakMap<RemoteClient[], CloudAuth>();

const instanceAttrs = (instanceId: string) => ({
  "spectrum.imessage.instance": instanceId,
});

export async function createCloudClients(
  projectId: string,
  projectSecret: string
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
   */
  const reconcile = (data: DedicatedTokenData): void => {
    if (Object.keys(data.auth ?? {}).length === 0) {
      // Never wipe a working set on a degenerate response. At startup `records`
      // is empty, so this still yields an empty array.
      authLog.warn(
        "imessage token response contained no lines; keeping the current set"
      );
      return;
    }
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

  const cloudAuth: CloudAuth = { dispose: renewal.dispose, forceRefresh };

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
