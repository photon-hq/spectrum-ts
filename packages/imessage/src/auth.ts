import { createClient } from "@photon-ai/advanced-imessage";
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
  let lastRefreshAt = Date.now();

  // The instanceId stays paired with each entry in this closure so renewal
  // can rewrite `entry.phone` in place without leaking instanceId onto the
  // public RemoteClient shape. Empty in shared mode.
  const records: { entry: RemoteClient; instanceId: string }[] = [];

  const syncPhones = (data: DedicatedTokenData) => {
    for (const { entry, instanceId } of records) {
      entry.phone = requirePhone(data, instanceId);
    }
  };

  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
      lastRefreshAt = Date.now();
      if (tokenData.type === "dedicated") {
        syncPhones(tokenData);
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
    const entries: RemoteClient[] = [
      {
        phone: SHARED_PHONE,
        client: createClient({
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
      },
    ];

    cloudAuthState.set(entries, cloudAuth);

    return entries;
  }

  const dedicated = tokenData;
  for (const [instanceId, token] of Object.entries(dedicated.auth)) {
    const entry: RemoteClient = {
      phone: requirePhone(dedicated, instanceId),
      client: createClient({
        address: `${instanceId}.imsg.photon.codes:443`,
        autoIdempotency: true,
        retry: true,
        tls: true,
        token: async () => {
          await renewal.refreshIfNeeded();
          const data = tokenData as DedicatedTokenData;
          return data.auth[instanceId] ?? token;
        },
      }),
    };
    records.push({ entry, instanceId });
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
