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
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const backoffDelay = (attempt: number, policy: RetryPolicy): number => {
  const exp = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  return Math.floor(Math.random() * capped);
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
        return Math.min(retryAfter * 1000, policy.maxDelayMs);
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
