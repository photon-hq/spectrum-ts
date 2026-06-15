import type { Store } from "../../utils/store";
import type { XRefreshConfig, XRefreshedTokens } from "./config";
import { refreshXAccessToken } from "./oauth";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const MIN_RENEWAL_MS = 5000;

/** Platform store key for the BYO-app direct auth sidecar. */
export const X_DIRECT_AUTH_STORE_KEY = "xDirectAuth";

export interface XDirectAuth {
  dispose(): void;
  getAccessToken(): Promise<string>;
}

interface CreateDirectAuthInput {
  config: XRefreshConfig;
  store: Store;
}

/**
 * SDK-side token sidecar for BYO-app direct mode. Refreshes the user access
 * token directly against X (no Spectrum Cloud) on a TTL timer, deduplicating
 * concurrent refreshes (single-flight) so the rotating, single-use refresh
 * token is never spent twice in parallel. Rotated tokens are surfaced via
 * `config.onTokensRefreshed` so the caller can persist them across restarts.
 */
export async function createDirectAuth({
  config,
  store,
}: CreateDirectAuthInput): Promise<XDirectAuth> {
  let accessToken = config.accessToken;
  let refreshToken = config.refreshToken;
  let expiresAt = 0;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlightRefresh: Promise<void> | undefined;

  const clearRenewalTimer = (): void => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  const notify = async (tokens: XRefreshedTokens): Promise<void> => {
    if (!config.onTokensRefreshed) {
      return;
    }
    try {
      await config.onTokensRefreshed(tokens);
    } catch (err) {
      console.warn(
        "[spectrum-ts] X onTokensRefreshed callback threw; ignoring.",
        err
      );
    }
  };

  const doRefresh = async (): Promise<void> => {
    const tokens = await refreshXAccessToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
      tokenUrl: config.tokenUrl,
    });
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    expiresAt = Date.now() + tokens.expiresIn * 1000;
    await notify(tokens);
  };

  // Single-flight: concurrent getAccessToken calls + the renewal timer share
  // one refresh instead of each spending the rotating refresh token.
  const refresh = (): Promise<void> => {
    if (!inFlightRefresh) {
      inFlightRefresh = doRefresh().finally(() => {
        inFlightRefresh = undefined;
      });
    }
    return inFlightRefresh;
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
        await refresh();
        scheduleRenewal();
      } catch (retryErr) {
        console.warn(
          `[spectrum-ts] X token refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
          retryErr
        );
        scheduleRetry();
      }
    }, RETRY_DELAY_MS);
    renewalTimer?.unref?.();
  };

  function scheduleRenewal(): void {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const remainingMs = expiresAt - Date.now();
    const renewInMs = Math.max(remainingMs * RENEWAL_RATIO, MIN_RENEWAL_MS);
    renewalTimer = setTimeout(async () => {
      try {
        await refresh();
        scheduleRenewal();
      } catch (err) {
        console.warn(
          `[spectrum-ts] X token refresh failed; retrying in ${RETRY_DELAY_MS}ms.`,
          err
        );
        scheduleRetry();
      }
    }, renewInMs);
    renewalTimer?.unref?.();
  }

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < expiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    await refresh();
    scheduleRenewal();
  };

  // Establish a known-expiry token up front (and rotate the configured refresh
  // token), mirroring the cloud sidecar's initial credential issue.
  await refresh();
  scheduleRenewal();

  const auth: XDirectAuth = {
    dispose(): void {
      disposed = true;
      clearRenewalTimer();
      store.delete(X_DIRECT_AUTH_STORE_KEY);
    },
    async getAccessToken(): Promise<string> {
      if (disposed) {
        throw new Error("X direct auth is disposed");
      }
      await refreshIfNeeded();
      return accessToken;
    },
  };

  store.set(X_DIRECT_AUTH_STORE_KEY, auth);
  return auth;
}

const isXDirectAuth = (value: unknown): value is XDirectAuth =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).getAccessToken === "function" &&
  typeof (value as Record<string, unknown>).dispose === "function";

export const getDirectAuth = (store: Store): XDirectAuth | undefined => {
  const value = store.get(X_DIRECT_AUTH_STORE_KEY);
  return isXDirectAuth(value) ? value : undefined;
};
