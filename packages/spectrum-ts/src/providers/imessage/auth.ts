import {
  type AdvancedIMessage,
  createClient,
} from "@photon-ai/advanced-imessage";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
} from "../../utils/cloud";
import type { Store } from "../../utils/store";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

export const NUMBERS_KEY = "numbers";

/**
 * Read the bidirectional phone↔instance mapping written by the iMessage cloud
 * auth path. Returns `{}` for local mode, BYO clients, or before the first
 * token issuance completes.
 */
export const getNumbers = (store: Store): Record<string, string> =>
  store.object<Record<string, string>>(NUMBERS_KEY) ?? {};

interface CloudAuth {
  dispose: () => void;
}

const cloudAuthState = new WeakMap<AdvancedIMessage[], CloudAuth>();

const buildNumbersMap = (data: DedicatedTokenData): Record<string, string> => {
  const mapping: Record<string, string> = {};
  for (const [instanceId, phone] of Object.entries(data.numbers ?? {})) {
    if (phone) {
      mapping[phone] = instanceId;
      mapping[instanceId] = phone;
    }
  }
  return mapping;
};

const writeNumbers = (
  store: Store,
  data: DedicatedTokenData | SharedTokenData
): void => {
  if (data.type === "dedicated") {
    store.set(NUMBERS_KEY, buildNumbersMap(data));
    return;
  }
  store.delete(NUMBERS_KEY);
};

export async function createCloudClients(
  projectId: string,
  projectSecret: string,
  store: Store
): Promise<AdvancedIMessage[]> {
  let tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
  let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;

  writeNumbers(store, tokenData);

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
        writeNumbers(store, tokenData);
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
    writeNumbers(store, tokenData);
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
