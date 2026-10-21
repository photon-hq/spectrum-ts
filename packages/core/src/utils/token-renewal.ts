import { createLogger } from "@photon-ai/otel";
import { errorAttrs } from "./telemetry";

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const MIN_RENEWAL_DELAY_MS = 5000;
const RETRY_DELAY_MS = 30_000;

export interface TokenRenewal {
  dispose(): Promise<void>;
  forceRefresh(): Promise<void>;
  invalidate(): void;
  refreshIfNeeded(): Promise<void>;
}

export interface TokenRenewalOptions {
  expiresInSeconds(): number;
  name: string;
  refresh(signal: AbortSignal): Promise<void>;
}

export const createTokenRenewal = (
  options: TokenRenewalOptions
): TokenRenewal => {
  const telemetryPrefix = `spectrum.${options.name}.auth`;
  const log = createLogger(telemetryPrefix);
  const lifetime = new AbortController();
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
    await options.refresh(lifetime.signal);
    lifetime.signal.throwIfAborted();
    tokenExpiresAt = Date.now() + options.expiresInSeconds() * 1000;
    onRefreshSuccess();
    scheduleRenewal();
  };

  const coalescedRefresh = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(lifetime.signal.reason);
    }
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
      if (disposed) {
        return;
      }
      onRefreshFailure(error);
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
    async dispose(): Promise<void> {
      disposed = true;
      clearRenewalTimer();
      lifetime.abort();
      await refreshInFlight?.catch(() => undefined);
    },
    forceRefresh: coalescedRefresh,
    invalidate(): void {
      if (!disposed) {
        tokenExpiresAt = 0;
      }
    },
    async refreshIfNeeded(): Promise<void> {
      lifetime.signal.throwIfAborted();
      if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
        return;
      }
      await coalescedRefresh();
    },
  };
};
