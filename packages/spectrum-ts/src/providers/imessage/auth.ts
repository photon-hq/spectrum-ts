import { createClient } from "@photon-ai/advanced-imessage";
import { cloud, type DedicatedTokenData } from "../../utils/cloud";
import { UnsupportedError } from "../../utils/errors";
import type { RemoteClient } from "./types";

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

  if (tokenData.type === "shared") {
    throw UnsupportedError.action(
      "multi-phone",
      "iMessage shared mode",
      "use dedicated-token cloud mode"
    );
  }

  // Captured outside `buildClients` so renewal can mutate `entry.phone` in
  // place, keeping live client refs and merged streams alive across renewals.
  // The instanceId stays in this closure (paired with the entry) so it does
  // not leak onto the public RemoteClient shape.
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
        if (tokenData.type === "shared") {
          throw UnsupportedError.action(
            "multi-phone",
            "iMessage shared mode",
            "use dedicated-token cloud mode"
          );
        }
        tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
        syncPhones(tokenData);
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
    if (tokenData.type === "shared") {
      throw UnsupportedError.action(
        "multi-phone",
        "iMessage shared mode",
        "use dedicated-token cloud mode"
      );
    }
    tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
    syncPhones(tokenData);
    scheduleRenewal();
  };

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
