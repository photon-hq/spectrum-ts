import {
  type AdvancedIMessage,
  createHttpClient,
} from "@photon-ai/advanced-imessage/http";
import {
  cloud,
  type DedicatedTokenData,
  type SharedTokenData,
} from "@spectrum-ts/core";
import { createTokenRenewal } from "@spectrum-ts/core/authoring";
import { type RemoteClient, SHARED_PHONE } from "./types";

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

interface CloudAuth {
  dispose: () => void;
}

interface DedicatedClientRecord {
  instanceId: string;
  phone: string;
}

const cloudAuthState = new WeakMap<RemoteClient[], CloudAuth>();

const httpAddress = (): string =>
  process.env.SPECTRUM_IMESSAGE_HTTP_ADDRESS ?? "imessage-http.photon.codes";

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
  const phone = data.numbers[instanceId];
  if (!(phone && E164_PATTERN.test(phone))) {
    throw new Error(
      `iMessage instance ${instanceId} has no valid E.164 phone assigned`
    );
  }
  return phone;
};

const dedicatedRecords = (
  data: DedicatedTokenData
): DedicatedClientRecord[] => {
  const records = Object.keys(data.auth).map((instanceId) => {
    requireInstanceToken(data, instanceId);
    return { instanceId, phone: requirePhone(data, instanceId) };
  });
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

const createSharedClients = (
  projectId: string,
  projectSecret: string,
  initial: SharedTokenData
): RemoteClient[] => {
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
    cloudAuthState.set(entries, { dispose: renewal.dispose });
    return entries;
  } catch (error) {
    renewal.dispose();
    throw error;
  }
};

const createDedicatedClients = async (
  projectId: string,
  projectSecret: string,
  initial: DedicatedTokenData
): Promise<RemoteClient[]> => {
  let tokenData = initial;
  const records = dedicatedRecords(tokenData);
  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      const refreshed = await cloud.issueImessageTokens(
        projectId,
        projectSecret
      );
      if (refreshed.type !== "dedicated") {
        throw new Error(
          "Dedicated iMessage token refresh returned shared credentials"
        );
      }
      const refreshedRecords = dedicatedRecords(refreshed);
      if (refreshedRecords.length !== records.length) {
        throw new Error(
          "iMessage token refresh changed the dedicated instance set; recreate the Spectrum client"
        );
      }
      for (const record of records) {
        const refreshedRecord = refreshedRecords.find(
          (candidate) => candidate.instanceId === record.instanceId
        );
        if (!refreshedRecord) {
          throw new Error(
            "iMessage token refresh changed the dedicated instance set; recreate the Spectrum client"
          );
        }
        if (refreshedRecord.phone !== record.phone) {
          throw new Error(
            `iMessage token refresh changed the phone for instance ${record.instanceId}; recreate the Spectrum client`
          );
        }
      }
      tokenData = refreshed;
    },
  });

  const opened: AdvancedIMessage[] = [];
  try {
    const entries = records.map((record): RemoteClient => {
      const client = createHttpClient({
        address: httpAddress(),
        autoIdempotency: true,
        retry: true,
        server: record.instanceId,
        token: async () => {
          await renewal.refreshIfNeeded();
          return requireInstanceToken(tokenData, record.instanceId);
        },
      });
      opened.push(client);
      return { client, phone: record.phone };
    });
    cloudAuthState.set(entries, { dispose: renewal.dispose });
    return entries;
  } catch (error) {
    renewal.dispose();
    await Promise.allSettled(opened.map((client) => client.close()));
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
