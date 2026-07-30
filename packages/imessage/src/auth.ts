import {
  type AdvancedIMessage,
  createHttpClient,
} from "@photon-ai/advanced-imessage/http";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
} from "@spectrum-ts/core";
import {
  createLogger,
  createTokenRenewal,
  errorAttrs,
  type TokenRenewal,
} from "@spectrum-ts/core/authoring";
import { type RemoteClient, SHARED_PHONE } from "./types";

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

// An unknown Fusor phone can force one Cloud inventory refresh immediately.
// Further events share an in-flight refresh and cannot re-mint more often than
// this floor, which bounds pressure when an event references a bad phone.
const FORCE_REFRESH_MIN_INTERVAL_MS = 5000;

const authLog = createLogger("spectrum.imessage.auth");

interface CloudAuth {
  dispose: () => void;
  forceRefresh: () => Promise<boolean>;
}

interface DedicatedClientRecord {
  instanceId: string;
  phone: string;
}

interface DedicatedClientWithInstance {
  client: AdvancedIMessage;
  instanceId: string;
}

interface PreparedDedicatedClient {
  entry: RemoteClient;
  instanceId: string;
}

const cloudAuthState = new WeakMap<RemoteClient[], CloudAuth>();

const instanceAttrs = (instanceId: string) => ({
  "spectrum.imessage.instance": instanceId,
});

const httpAddress = (): string =>
  process.env.SPECTRUM_IMESSAGE_HTTP_ADDRESS ?? "imessage-http.photon.codes";

const requireSharedToken = (data: SharedTokenData): string => {
  if (!data.token.trim()) {
    throw new Error("Shared iMessage token response is missing token");
  }
  return data.token;
};

const requireInstanceToken = (
  data: DedicatedTokenData,
  instanceId: string
): string => {
  const token = data.auth[instanceId];
  if (!token?.trim()) {
    throw new Error(
      `Dedicated iMessage token response is missing auth for instance ${instanceId}`
    );
  }
  return token;
};

const dedicatedRecords = (
  data: DedicatedTokenData,
  entriesByInstance: ReadonlyMap<string, RemoteClient>
): DedicatedClientRecord[] => {
  const records: DedicatedClientRecord[] = [];
  for (const instanceId of Object.keys(data.auth)) {
    requireInstanceToken(data, instanceId);
    const discoveredPhone = data.numbers[instanceId];
    if (discoveredPhone === null || discoveredPhone === undefined) {
      const existing = entriesByInstance.get(instanceId);
      if (existing) {
        authLog.warn(
          "imessage line lost its phone number; keeping the last known number",
          instanceAttrs(instanceId)
        );
        records.push({ instanceId, phone: existing.phone });
      } else {
        authLog.warn(
          "skipping imessage line without a phone number",
          instanceAttrs(instanceId)
        );
      }
      continue;
    }
    if (!E164_PATTERN.test(discoveredPhone)) {
      throw new Error(
        `iMessage instance ${instanceId} has no valid E.164 phone assigned`
      );
    }
    records.push({ instanceId, phone: discoveredPhone });
  }
  const phones = new Set<string>();
  for (const record of records) {
    if (phones.has(record.phone)) {
      throw new Error(
        `Dedicated iMessage token response contains duplicate phone ${record.phone}`
      );
    }
    phones.add(record.phone);
  }
  return records;
};

const createBoundedForceRefresh = (
  renewal: TokenRenewal,
  isDisposed: () => boolean
): (() => Promise<boolean>) => {
  let lastForcedRefreshAt: number | undefined;
  let forceRefreshInFlight: Promise<void> | undefined;

  return async (): Promise<boolean> => {
    if (isDisposed()) {
      return false;
    }
    if (forceRefreshInFlight) {
      await forceRefreshInFlight;
      return true;
    }
    const now = Date.now();
    if (
      lastForcedRefreshAt !== undefined &&
      now - lastForcedRefreshAt < FORCE_REFRESH_MIN_INTERVAL_MS
    ) {
      // No inventory request happened for this caller. Returning false keeps an
      // unknown line retryable until the floor permits a genuinely fresh read;
      // otherwise a different line discovered by the previous refresh could
      // make this caller treat stale inventory as authoritative and drop its
      // first event.
      return false;
    }
    lastForcedRefreshAt = now;
    forceRefreshInFlight = renewal.forceRefresh().finally(() => {
      forceRefreshInFlight = undefined;
    });
    await forceRefreshInFlight;
    return true;
  };
};

const createSharedClients = (
  projectId: string,
  projectSecret: string,
  initial: SharedTokenData
): RemoteClient[] => {
  let disposed = false;
  let tokenData = initial;
  requireSharedToken(tokenData);
  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      const refreshed = await cloud.issueImessageTokens(
        projectId,
        projectSecret
      );
      if (disposed) {
        return;
      }
      if (refreshed.type !== "shared") {
        throw new Error(
          "Shared iMessage token refresh returned dedicated credentials"
        );
      }
      requireSharedToken(refreshed);
      tokenData = refreshed;
    },
  });

  try {
    const entries: RemoteClient[] = [
      {
        phone: SHARED_PHONE,
        client: createHttpClient({
          address: httpAddress(),
          autoIdempotency: true,
          retry: true,
          token: async () => {
            await renewal.refreshIfNeeded();
            return requireSharedToken(tokenData);
          },
        }),
      },
    ];
    cloudAuthState.set(entries, {
      dispose: () => {
        disposed = true;
        renewal.dispose();
      },
      forceRefresh: createBoundedForceRefresh(renewal, () => disposed),
    });
    return entries;
  } catch (error) {
    disposed = true;
    renewal.dispose();
    throw error;
  }
};

const createDedicatedClients = async (
  projectId: string,
  projectSecret: string,
  initial: DedicatedTokenData
): Promise<RemoteClient[]> => {
  let disposed = false;
  let tokenData = initial;
  const entries: RemoteClient[] = [];
  const entriesByInstance = new Map<string, RemoteClient>();
  // Validate before starting renewal so invalid discovery cannot create any
  // clients or timers. A provisioned instance without a phone is intentionally
  // skipped until Cloud assigns one.
  const initialRecords = dedicatedRecords(initial, entriesByInstance);

  const closeClients = async (
    clients: DedicatedClientWithInstance[]
  ): Promise<void> => {
    const results = await Promise.allSettled(
      clients.map(({ client }) => client.close())
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        continue;
      }
      const record = clients[index];
      authLog.warn(
        "failed to close imessage line",
        {
          ...(record ? instanceAttrs(record.instanceId) : {}),
          ...errorAttrs(result.reason),
        },
        result.reason instanceof Error ? result.reason : undefined
      );
    }
  };

  let renewal: TokenRenewal;

  const buildEntry = (record: DedicatedClientRecord): RemoteClient => ({
    phone: record.phone,
    client: createHttpClient({
      address: httpAddress(),
      autoIdempotency: true,
      retry: true,
      server: record.instanceId,
      token: async () => {
        await renewal.refreshIfNeeded();
        return requireInstanceToken(tokenData, record.instanceId);
      },
    }),
  });

  const prepareAdditions = async (
    nextRecords: DedicatedClientRecord[]
  ): Promise<PreparedDedicatedClient[]> => {
    const additions: PreparedDedicatedClient[] = [];
    try {
      for (const record of nextRecords) {
        if (!entriesByInstance.has(record.instanceId)) {
          additions.push({
            entry: buildEntry(record),
            instanceId: record.instanceId,
          });
        }
      }
      return additions;
    } catch (error) {
      await closeClients(
        additions.map(({ entry, instanceId }) => ({
          client: entry.client,
          instanceId,
        }))
      );
      throw error;
    }
  };

  const syncExistingPhones = (nextRecords: DedicatedClientRecord[]): void => {
    for (const record of nextRecords) {
      const existing = entriesByInstance.get(record.instanceId);
      if (existing) {
        existing.phone = record.phone;
      }
    }
  };

  const removeMissing = (
    nextByInstance: Map<string, DedicatedClientRecord>
  ): DedicatedClientWithInstance[] => {
    const removed: DedicatedClientWithInstance[] = [];
    for (const [instanceId, entry] of entriesByInstance) {
      if (nextByInstance.has(instanceId)) {
        continue;
      }
      entriesByInstance.delete(instanceId);
      const index = entries.indexOf(entry);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      removed.push({ client: entry.client, instanceId });
    }
    return removed;
  };

  const appendAdditions = (additions: PreparedDedicatedClient[]): void => {
    for (const { entry, instanceId } of additions) {
      entriesByInstance.set(instanceId, entry);
      entries.push(entry);
    }
  };

  const reconcile = async (
    data: DedicatedTokenData,
    nextRecords = dedicatedRecords(data, entriesByInstance)
  ): Promise<void> => {
    if (disposed) {
      return;
    }

    const nextByInstance = new Map(
      nextRecords.map((record) => [record.instanceId, record])
    );
    const additions = await prepareAdditions(nextRecords);
    if (disposed) {
      await closeClients(
        additions.map(({ entry, instanceId }) => ({
          client: entry.client,
          instanceId,
        }))
      );
      return;
    }

    // Everything that can reject has completed. Commit the new token payload
    // and mutate the existing array object in place so all holders observe the
    // same inventory without orphaning WeakMap state.
    tokenData = data;
    syncExistingPhones(nextRecords);
    const removed = removeMissing(nextByInstance);
    appendAdditions(additions);

    if (additions.length > 0 || removed.length > 0) {
      authLog.info("imessage lines reconciled", {
        "spectrum.imessage.lines.added": additions.length,
        "spectrum.imessage.lines.removed": removed.length,
        "spectrum.imessage.lines.total": entries.length,
      });
    }
    await closeClients(removed);
  };

  renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      const refreshed = await cloud.issueImessageTokens(
        projectId,
        projectSecret
      );
      if (disposed) {
        return;
      }
      if (refreshed.type !== "dedicated") {
        throw new Error(
          "Dedicated iMessage token refresh returned shared credentials"
        );
      }
      await reconcile(refreshed);
    },
  });

  try {
    await reconcile(initial, initialRecords);
    cloudAuthState.set(entries, {
      dispose: () => {
        disposed = true;
        renewal.dispose();
      },
      forceRefresh: createBoundedForceRefresh(renewal, () => disposed),
    });
    return entries;
  } catch (error) {
    disposed = true;
    renewal.dispose();
    throw error;
  }
};

export async function createCloudClients(
  projectId: string,
  projectSecret: string
): Promise<RemoteClient[]> {
  const issued = await cloud.issueImessageTokens(projectId, projectSecret);
  switch (issued.type) {
    case "dedicated":
      return await createDedicatedClients(projectId, projectSecret, issued);
    case "shared":
      return createSharedClients(projectId, projectSecret, issued);
    default:
      throw new Error("Unsupported iMessage mode returned by Spectrum Cloud");
  }
}

export async function disposeCloudAuth(clients: RemoteClient[]): Promise<void> {
  const auth = cloudAuthState.get(clients);
  if (auth) {
    auth.dispose();
    cloudAuthState.delete(clients);
  }
}

/**
 * Returns a bounded Cloud refresh hook for cloud-backed client arrays. Fusor
 * can invoke it once when a dedicated event names an unknown phone, then retry
 * routing against the same live array. Static-token clients return undefined.
 */
export function getCloudRecover(
  clients: RemoteClient[]
): (() => Promise<boolean>) | undefined {
  return cloudAuthState.get(clients)?.forceRefresh;
}
