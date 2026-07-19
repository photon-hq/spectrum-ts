import { createLogger } from "@photon-ai/otel";
import { errorAttrs } from "./telemetry";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const MIN_RENEWAL_DELAY_MS = 5000;
const RETRY_DELAY_MS = 30_000;

export interface TokenRenewal {
  dispose(): void;
  forceRefresh(): Promise<void>;
  invalidate(): void;
  refreshIfNeeded(): Promise<void>;
}

export interface TokenRenewalOptions {
  expiresInSeconds(): number;
  name: string;
  refresh(): Promise<void>;
}

export const createTokenRenewal = (
  options: TokenRenewalOptions
): TokenRenewal => {
  const telemetryPrefix = `spectrum.${options.name}.auth`;
  const log = createLogger(telemetryPrefix);
  let disposed = false;
  let refreshFailures = 0;
  let refreshInFlight: Promise<void> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let tokenExpiresAt = Date.now() + options.expiresInSeconds() * 1000;

  const clearRenewalTimer = (): void => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  const onRefreshSuccess = (): void => {
    if (refreshFailures > 0) {
      log.info(`${options.name} token refresh recovered`, {
        [`${telemetryPrefix}.attempt`]: refreshFailures,
      });
      refreshFailures = 0;
    }
  };

  const onRefreshFailure = (error: unknown): void => {
    refreshFailures += 1;
    log.warn(
      `${options.name} token refresh failed; retrying`,
      {
        [`${telemetryPrefix}.attempt`]: refreshFailures,
        [`${telemetryPrefix}.retry_in_ms`]: RETRY_DELAY_MS,
        ...errorAttrs(error),
      },
      error
    );
  };

  const refreshNow = async (): Promise<void> => {
    await options.refresh();
    tokenExpiresAt = Date.now() + options.expiresInSeconds() * 1000;
    onRefreshSuccess();
    scheduleRenewal();
  };

  const coalescedRefresh = (): Promise<void> => {
    if (!refreshInFlight) {
      refreshInFlight = refreshNow().finally(() => {
        refreshInFlight = undefined;
      });
    }
    return refreshInFlight;
  };

  const runScheduledRefresh = (): void => {
    if (disposed) {
      return;
    }
    coalescedRefresh().catch((error) => {
      onRefreshFailure(error);
      if (disposed) {
        return;
      }
      renewalTimer = setTimeout(runScheduledRefresh, RETRY_DELAY_MS);
      renewalTimer?.unref?.();
    });
  };

  const scheduleRenewal = (): void => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const ttlMs = options.expiresInSeconds() * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, MIN_RENEWAL_DELAY_MS);
    renewalTimer = setTimeout(runScheduledRefresh, renewInMs);
    renewalTimer?.unref?.();
  };

  scheduleRenewal();

  return {
    dispose(): void {
      disposed = true;
      clearRenewalTimer();
    },
    forceRefresh: coalescedRefresh,
    invalidate(): void {
      tokenExpiresAt = 0;
    },
    async refreshIfNeeded(): Promise<void> {
      if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
        return;
      }
      await coalescedRefresh();
    },
  };
};
