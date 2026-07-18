import {
  type AdvancedIMessage,
  createGrpcClient,
} from "@photon-ai/advanced-imessage/grpc";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
} from "@spectrum-ts/core";
import { createTokenRenewal } from "@spectrum-ts/core/authoring";
import { type RemoteClient, SHARED_PHONE } from "./types";

// Floor between forced re-mints so a stream reconnect storm can't hammer the
// cloud token endpoint — well below any token TTL, just enough to coalesce the
// message + poll streams asking at nearly the same instant.
const FORCE_REFRESH_MIN_INTERVAL_MS = 5000;

interface CloudAuth {
  dispose: () => void;
  forceRefresh: () => Promise<void>;
}

const cloudAuthState = new WeakMap<RemoteClient[], CloudAuth>();

const proxyAddress = (): string =>
  process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";

const requireProxyToken = (data: DedicatedTokenData): string => {
  if (!data.proxyToken) {
    throw new Error(
      "Dedicated iMessage token response is missing proxyToken; virtual spc-* resources cannot be routed through Spectrum"
    );
  }
  return data.proxyToken;
};

const requireSharedToken = (data: SharedTokenData): string => {
  if (!data.token) {
    throw new Error("Shared iMessage token response is missing token");
  }
  return data.token;
};

const requireInstanceToken = (
  data: DedicatedTokenData,
  instanceId: string
): string => {
  const token = data.auth[instanceId];
  if (!token) {
    throw new Error(
      `Dedicated iMessage token response is missing auth for instance ${instanceId}`
    );
  }
  return token;
};

const requirePhone = (data: DedicatedTokenData, instanceId: string): string => {
  const phone = data.numbers?.[instanceId];
  if (!phone) {
    throw new Error(`iMessage instance ${instanceId} has no phone assigned`);
  }
  return phone;
};

export async function createCloudClients(
  projectId: string,
  projectSecret: string
): Promise<RemoteClient[]> {
  let tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
  if (tokenData.type === "dedicated") {
    requireProxyToken(tokenData);
  } else {
    requireSharedToken(tokenData);
  }
  const tokenMode = tokenData.type;
  let lastRefreshAt = Date.now();

  // Keep the instanceId paired with each entry so renewal can validate the
  // complete direct credential set. Stream routing captures the initial phone,
  // so a line/topology change must rebuild the Spectrum client. Empty in
  // shared mode.
  const records: { entry: RemoteClient; instanceId: string }[] = [];

  const validateDedicatedRecords = (data: DedicatedTokenData): void => {
    for (const { entry, instanceId } of records) {
      requireInstanceToken(data, instanceId);
      const phone = requirePhone(data, instanceId);
      if (phone !== entry.phone) {
        throw new Error(
          `iMessage token refresh changed the phone for instance ${instanceId}; recreate the Spectrum client`
        );
      }
    }
    if (Object.keys(data.auth).length !== records.length) {
      throw new Error(
        "iMessage token refresh changed the dedicated instance set; recreate the Spectrum client"
      );
    }
  };

  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      const refreshed = await cloud.issueImessageTokens(
        projectId,
        projectSecret
      );
      if (refreshed.type !== tokenMode) {
        throw new Error(
          `iMessage token refresh changed mode from ${tokenMode} to ${refreshed.type}; recreate the Spectrum client`
        );
      }
      if (refreshed.type === "dedicated") {
        requireProxyToken(refreshed);
        validateDedicatedRecords(refreshed);
      } else {
        requireSharedToken(refreshed);
      }
      // Commit only a fully validated credential set. A malformed refresh
      // leaves the last known-good tokens and routing together.
      tokenData = refreshed;
      lastRefreshAt = Date.now();
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
    const entries: RemoteClient[] = [
      {
        phone: SHARED_PHONE,
        client: createGrpcClient({
          address: proxyAddress(),
          // Auto-retry transient unary failures so a brief server blip during
          // an outbound action (send/react/reply) doesn't surface as an
          // uncaught error. `autoIdempotency` attaches an x-idempotency-key to
          // mutating RPCs so the retry can't double-apply.
          autoIdempotency: true,
          retry: true,
          tls: true,
          token: async () => {
            await renewal.refreshIfNeeded();
            const data = tokenData;
            if (data.type !== "shared") {
              throw new Error(
                "Shared iMessage token refresh returned dedicated credentials"
              );
            }
            return requireSharedToken(data);
          },
        }),
      },
    ];

    cloudAuthState.set(entries, cloudAuth);

    return entries;
  }

  const dedicated = tokenData;
  const dedicatedEntries = Object.keys(dedicated.auth).map((instanceId) => {
    requireInstanceToken(dedicated, instanceId);
    return {
      instanceId,
      phone: requirePhone(dedicated, instanceId),
    };
  });
  if (dedicatedEntries.length === 0) {
    const entries: RemoteClient[] = [];
    cloudAuthState.set(entries, cloudAuth);
    return entries;
  }
  const openedClients: AdvancedIMessage[] = [];
  try {
    const resourceClient = createGrpcClient({
      address: proxyAddress(),
      autoIdempotency: true,
      retry: true,
      tls: true,
      token: async () => {
        await renewal.refreshIfNeeded();
        const data = tokenData;
        if (data.type !== "dedicated") {
          throw new Error(
            "Dedicated iMessage token refresh returned shared credentials"
          );
        }
        return requireProxyToken(data);
      },
    });
    openedClients.push(resourceClient);
    for (const { instanceId, phone } of dedicatedEntries) {
      const directClient = createGrpcClient({
        address: `${instanceId}.imsg.photon.codes:443`,
        autoIdempotency: true,
        retry: true,
        tls: true,
        token: async () => {
          await renewal.refreshIfNeeded();
          const data = tokenData;
          if (data.type !== "dedicated") {
            throw new Error(
              "Dedicated iMessage token refresh returned shared credentials"
            );
          }
          return requireInstanceToken(data, instanceId);
        },
      });
      openedClients.push(directClient);
      const entry: RemoteClient = {
        client: directClient,
        instanceId,
        phone,
        resourceClient,
      };
      records.push({ entry, instanceId });
    }
  } catch (error) {
    renewal.dispose();
    await Promise.allSettled(openedClients.map((client) => client.close()));
    throw error;
  }
  const entries = records.map((r) => r.entry);

  cloudAuthState.set(entries, cloudAuth);

  return entries;
}

export async function disposeCloudAuth(clients: RemoteClient[]): Promise<void> {
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
