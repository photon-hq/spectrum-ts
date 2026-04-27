import { TelegramApiError, TelegramNetworkError } from "./errors";

export interface RetryPolicy {
  baseDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
  retryNetworkErrors: boolean;
  retryServerErrors: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  retryServerErrors: true,
  retryNetworkErrors: true,
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finalize = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      finalize(() => reject(signal?.reason));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    // Re-check after attaching the listener to close the race window where
    // the signal aborts between entry and listener registration.
    if (signal?.aborted) {
      onAbort();
      return;
    }

    timer = setTimeout(() => {
      finalize(resolve);
    }, ms);
  });

const backoffDelay = (attempt: number, policy: RetryPolicy): number => {
  const exp = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  // Full jitter in [50%, 100%] of the capped delay so callers never get a
  // 0ms "retry immediately" window that defeats the backoff.
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
};

const nextDelay = (
  error: unknown,
  attempt: number,
  policy: RetryPolicy
): number | undefined => {
  if (attempt >= policy.maxAttempts) {
    return undefined;
  }
  if (error instanceof TelegramApiError) {
    if (error.isRateLimit) {
      const retryAfter = error.retryAfter;
      if (retryAfter !== undefined) {
        // `retry_after` is Telegram telling us exactly when the rate limit
        // window opens. Clamping it to `maxDelayMs` would retry too early,
        // earn another 429, and burn through `maxAttempts` without ever
        // respecting the limit. Callers wanting to bound how long a single
        // request can hang can use `TelegramClientOptions.requestTimeoutMs`,
        // which still applies via the merged abort signal.
        return retryAfter * 1000;
      }
      return backoffDelay(attempt, policy);
    }
    if (error.isServerError && policy.retryServerErrors) {
      return backoffDelay(attempt, policy);
    }
    return undefined;
  }
  if (error instanceof TelegramNetworkError && policy.retryNetworkErrors) {
    return backoffDelay(attempt, policy);
  }
  return undefined;
};

export const withRetry = async <T>(
  op: () => Promise<T>,
  opts: { policy?: Partial<RetryPolicy>; signal?: AbortSignal } = {}
): Promise<T> => {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.policy };
  let attempt = 1;

  while (true) {
    try {
      return await op();
    } catch (error) {
      const delay = nextDelay(error, attempt, policy);
      if (delay === undefined) {
        throw error;
      }
      await sleep(delay, opts.signal);
      attempt += 1;
    }
  }
};
