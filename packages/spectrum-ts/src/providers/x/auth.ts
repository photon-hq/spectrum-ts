import { cloud, type XCredentialsData } from "../../utils/cloud";
import type { Store } from "../../utils/store";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

/** Platform store key for the cloud auth sidecar. */
export const X_AUTH_STORE_KEY = "xAuth";

export interface XCloudAuth {
  dispose(): void;
  getAccessToken(xUserId?: string): Promise<string>;
  getConsumerSecret(): Promise<string>;
  getXUserId(): string;
}

interface CreateCloudAuthInput {
  pinnedXUserId?: string;
  projectId: string;
  projectSecret: string;
  store: Store;
}

const tokenExpiresAt = (data: XCredentialsData): number =>
  Date.now() + data.expiresIn * 1000;

const xUserIdsFromCredentials = (data: XCredentialsData): string[] =>
  Object.keys(data.auth);

const assertHasAccounts = (data: XCredentialsData): void => {
  if (xUserIdsFromCredentials(data).length === 0) {
    throw new Error("No X accounts linked. Connect a bot via the dashboard.");
  }
};

const assertPinnedUserExists = (
  data: XCredentialsData,
  pinnedXUserId?: string
): void => {
  if (!pinnedXUserId) {
    return;
  }
  if (data.auth[pinnedXUserId]) {
    return;
  }
  throw new Error(
    `Configured xUserId "${pinnedXUserId}" is not linked to this project.`
  );
};

const resolveDefaultXUserId = (
  data: XCredentialsData,
  pinnedXUserId?: string
): string => {
  if (pinnedXUserId) {
    return pinnedXUserId;
  }
  const ids = xUserIdsFromCredentials(data);
  if (ids.length === 1) {
    const id = ids[0];
    if (id) {
      return id;
    }
  }
  throw new Error(
    "Multiple X accounts linked. Pass xUserId in x.config({ xUserId: '...' })."
  );
};

/**
 * Cloud-mode token sidecar for the fusor X provider. Refreshes credentials from
 * `POST /projects/:id/x/credentials` on TTL and exposes them via the platform
 * store — inbound stays on Fusor; outbound reads resolved tokens at call time.
 */
export async function createCloudAuth({
  projectId,
  projectSecret,
  pinnedXUserId,
  store,
}: CreateCloudAuthInput): Promise<XCloudAuth> {
  let credentials = await cloud.issueXCredentials(projectId, projectSecret);
  assertHasAccounts(credentials);
  assertPinnedUserExists(credentials, pinnedXUserId);

  const defaultXUserId = resolveDefaultXUserId(credentials, pinnedXUserId);
  let expiresAt = tokenExpiresAt(credentials);
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;

  const clearRenewalTimer = (): void => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  const refreshCredentials = async (): Promise<XCredentialsData> => {
    const data = await cloud.issueXCredentials(projectId, projectSecret);
    assertHasAccounts(data);
    assertPinnedUserExists(data, pinnedXUserId);
    credentials = data;
    expiresAt = tokenExpiresAt(data);
    return data;
  };

  const scheduleRetry = (): void => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    renewalTimer = setTimeout(async () => {
      if (disposed) {
        return;
      }
      try {
        await refreshCredentials();
        scheduleRenewal();
      } catch (retryErr) {
        console.warn(
          `[spectrum-ts] X credential refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
          retryErr
        );
        scheduleRetry();
      }
    }, RETRY_DELAY_MS);
    renewalTimer?.unref?.();
  };

  const scheduleRenewal = (): void => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const ttlMs = credentials.expiresIn * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

    renewalTimer = setTimeout(async () => {
      try {
        await refreshCredentials();
        scheduleRenewal();
      } catch (err) {
        console.warn(
          `[spectrum-ts] X credential refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
          err
        );
        scheduleRetry();
      }
    }, renewInMs);
    renewalTimer?.unref?.();
  };

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < expiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    await refreshCredentials();
    scheduleRenewal();
  };

  const auth: XCloudAuth = {
    dispose(): void {
      disposed = true;
      clearRenewalTimer();
      store.delete(X_AUTH_STORE_KEY);
    },
    async getAccessToken(xUserId = defaultXUserId): Promise<string> {
      if (disposed) {
        throw new Error("X cloud auth is disposed");
      }
      await refreshIfNeeded();
      const token = credentials.auth[xUserId];
      if (!token) {
        throw new Error(
          `X account "${xUserId}" is not linked to this project.`
        );
      }
      return token;
    },
    async getConsumerSecret(): Promise<string> {
      if (disposed) {
        throw new Error("X cloud auth is disposed");
      }
      await refreshIfNeeded();
      return credentials.consumerSecret;
    },
    getXUserId(): string {
      return defaultXUserId;
    },
  };

  scheduleRenewal();
  store.set(X_AUTH_STORE_KEY, auth);
  return auth;
}

const isXCloudAuth = (value: unknown): value is XCloudAuth =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).getAccessToken === "function" &&
  typeof (value as Record<string, unknown>).getConsumerSecret === "function" &&
  typeof (value as Record<string, unknown>).getXUserId === "function";

export const getCloudAuth = (store: Store): XCloudAuth | undefined => {
  const value = store.get(X_AUTH_STORE_KEY);
  return isXCloudAuth(value) ? value : undefined;
};
