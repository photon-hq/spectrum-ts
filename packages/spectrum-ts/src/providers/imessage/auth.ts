import {
  type AdvancedIMessage,
  createClient,
} from "@photon-ai/advanced-imessage";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
} from "../../utils/cloud";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

interface CloudAuth {
  dispose: () => void;
}

const cloudAuthState = new WeakMap<AdvancedIMessage[], CloudAuth>();

export async function createCloudClients(
  projectId: string,
  projectSecret: string
): Promise<AdvancedIMessage[]> {
  let tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
  let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;

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
    scheduleRenewal();
  };

  const buildClients = (): AdvancedIMessage[] => {
    if (tokenData.type === "shared") {
      const address =
        process.env.SPECTRUM_IMESSAGE_ADDRESS ??
        "imessage.spectrum.photon.codes:443";

      return [
        createClient({
          address,
          tls: true,
          token: async () => {
            await refreshIfNeeded();
            return (tokenData as SharedTokenData).token;
          },
        }),
      ];
    }

    return Object.entries(tokenData.auth).map(([instanceId, token]) =>
      createClient({
        address: `${instanceId}.imsg.photon.codes:443`,
        tls: true,
        token: async () => {
          await refreshIfNeeded();
          const data = tokenData as DedicatedTokenData;
          return data.auth[instanceId] ?? token;
        },
      })
    );
  };

  const clients = buildClients();

  cloudAuthState.set(clients, {
    dispose: () => {
      disposed = true;
      if (renewalTimer !== undefined) {
        clearTimeout(renewalTimer);
        renewalTimer = undefined;
      }
    },
  });

  return clients;
}

export async function disposeCloudAuth(
  clients: AdvancedIMessage[]
): Promise<void> {
  const auth = cloudAuthState.get(clients);
  if (auth) {
    auth.dispose();
    cloudAuthState.delete(clients);
  }
}
