import { createLogger } from "@photon-ai/otel";
import { cloud } from "../utils/cloud";
import { errorAttrs } from "../utils/telemetry";

const log = createLogger("spectrum.fusor.auth");

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

export interface FusorTokenProvider {
  dispose(): Promise<void>;
  getToken(): Promise<string>;
  invalidate(): void;
}

/**
 * Single-token provider for the fusor stream. Mirrors the renewal cadence
 * of the slack provider package's auth but without per-team bookkeeping —
 * fusor issues one bearer JWT per project.
 */
export function createFusorTokenProvider(
  projectId: string,
  projectSecret: string
): Promise<FusorTokenProvider> {
  return (async () => {
    let tokenData = await cloud.issueFusorToken(projectId, projectSecret);
    let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
    let disposed = false;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshFailures = 0;

    const clearRenewalTimer = () => {
      if (renewalTimer !== undefined) {
        clearTimeout(renewalTimer);
        renewalTimer = undefined;
      }
    };

    const refresh = async (): Promise<void> => {
      tokenData = await cloud.issueFusorToken(projectId, projectSecret);
      tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
    };

    const onRefreshSuccess = () => {
      if (refreshFailures > 0) {
        log.info("fusor token refresh recovered", {
          "spectrum.fusor.auth.attempt": refreshFailures,
        });
        refreshFailures = 0;
      }
    };

    const onRefreshFailure = (error: unknown) => {
      refreshFailures += 1;
      log.warn(
        "fusor token refresh failed; retrying",
        {
          "spectrum.fusor.auth.attempt": refreshFailures,
          "spectrum.fusor.auth.retry_in_ms": RETRY_DELAY_MS,
          ...errorAttrs(error),
        },
        error
      );
    };

    const scheduleRetry = () => {
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
          onRefreshSuccess();
          scheduleRenewal();
        } catch (retryErr) {
          onRefreshFailure(retryErr);
          scheduleRetry();
        }
      }, RETRY_DELAY_MS);
      renewalTimer?.unref?.();
    };

    const scheduleRenewal = () => {
      if (disposed) {
        return;
      }
      clearRenewalTimer();
      const ttlMs = tokenData.expiresIn * 1000;
      const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

      renewalTimer = setTimeout(async () => {
        try {
          await refresh();
          onRefreshSuccess();
          scheduleRenewal();
        } catch (err) {
          onRefreshFailure(err);
          scheduleRetry();
        }
      }, renewInMs);
      renewalTimer?.unref?.();
    };

    scheduleRenewal();

    return {
      async getToken(): Promise<string> {
        if (Date.now() >= tokenExpiresAt - EXPIRY_BUFFER_MS) {
          await refresh();
          onRefreshSuccess();
          scheduleRenewal();
        }
        return tokenData.token;
      },
      invalidate(): void {
        tokenExpiresAt = 0;
      },
      async dispose(): Promise<void> {
        disposed = true;
        clearRenewalTimer();
      },
    };
  })();
}
