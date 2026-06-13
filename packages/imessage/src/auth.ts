import { createClient } from "@photon-ai/advanced-imessage";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
} from "@spectrum-ts/core";
import { type RemoteClient, SHARED_PHONE } from "./types";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

interface CloudAuth {
  dispose: () => void;
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
  let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;

  // The instanceId stays paired with each entry in this closure so renewal
  // can rewrite `entry.phone` in place without leaking instanceId onto the
  // public RemoteClient shape. Empty in shared mode.
  const records: { entry: RemoteClient; instanceId: string }[] = [];

  const syncPhones = (data: DedicatedTokenData) => {
    for (const { entry, instanceId } of records) {
      entry.phone = requirePhone(data, instanceId);
    }
  };

  const scheduleRenewal = () => {
    if (disposed) {
      return;
    }
    const ttlMs = tokenData.expiresIn * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

    renewalTimer = setTimeout(async () => {
      try {
        tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
        tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
        if (tokenData.type === "dedicated") {
          syncPhones(tokenData);
        }
        scheduleRenewal();
      } catch {
        renewalTimer = setTimeout(() => scheduleRenewal(), RETRY_DELAY_MS);
        renewalTimer?.unref?.();
      }
    }, renewInMs);
    renewalTimer?.unref?.();
  };

  scheduleRenewal();

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
    tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
    if (tokenData.type === "dedicated") {
      syncPhones(tokenData);
    }
    scheduleRenewal();
  };

  if (tokenData.type === "shared") {
    const address =
      process.env.SPECTRUM_IMESSAGE_ADDRESS ??
      "imessage.spectrum.photon.codes:443";
    const entries: RemoteClient[] = [
      {
        phone: SHARED_PHONE,
        client: createClient({
          address,
          tls: true,
          token: async () => {
            await refreshIfNeeded();
            return (tokenData as SharedTokenData).token;
          },
        }),
      },
    ];

    cloudAuthState.set(entries, {
      dispose: () => {
        disposed = true;
        if (renewalTimer !== undefined) {
          clearTimeout(renewalTimer);
          renewalTimer = undefined;
        }
      },
    });

    return entries;
  }

  const dedicated = tokenData;
  for (const [instanceId, token] of Object.entries(dedicated.auth)) {
    const entry: RemoteClient = {
      phone: requirePhone(dedicated, instanceId),
      client: createClient({
        address: `${instanceId}.imsg.photon.codes:443`,
        tls: true,
        token: async () => {
          await refreshIfNeeded();
          const data = tokenData as DedicatedTokenData;
          return data.auth[instanceId] ?? token;
        },
      }),
    };
    records.push({ entry, instanceId });
  }
  const entries = records.map((r) => r.entry);

  cloudAuthState.set(entries, {
    dispose: () => {
      disposed = true;
      if (renewalTimer !== undefined) {
        clearTimeout(renewalTimer);
        renewalTimer = undefined;
      }
    },
  });

  return entries;
}

export async function disposeCloudAuth(clients: RemoteClient[]): Promise<void> {
  const auth = cloudAuthState.get(clients);
  if (auth) {
    auth.dispose();
    cloudAuthState.delete(clients);
  }
}
