import { GrammyError, HttpError } from "grammy";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LOG_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface TelegramLogger {
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export const createLogger = (level: LogLevel = "error"): TelegramLogger => {
  const threshold = LOG_LEVELS[level];
  const noop = () => {};

  return {
    debug:
      threshold >= LOG_LEVELS.debug
        ? (msg, ...args) => console.debug(`[Telegram] ${msg}`, ...args)
        : noop,
    info:
      threshold >= LOG_LEVELS.info
        ? (msg, ...args) => console.info(`[Telegram] ${msg}`, ...args)
        : noop,
    warn:
      threshold >= LOG_LEVELS.warn
        ? (msg, ...args) => console.warn(`[Telegram] ${msg}`, ...args)
        : noop,
    error:
      threshold >= LOG_LEVELS.error
        ? (msg, ...args) => console.error(`[Telegram] ${msg}`, ...args)
        : noop,
  };
};

export class TelegramError extends Error {
  readonly errorCode: number;
  readonly description: string;
  readonly retryAfter?: number;

  constructor(errorCode: number, description: string, retryAfter?: number) {
    super(`Telegram API error ${errorCode}: ${description}`);
    this.name = "TelegramError";
    this.errorCode = errorCode;
    this.description = description;
    this.retryAfter = retryAfter;
  }

  static fromGrammyError(err: GrammyError): TelegramError {
    const retryAfter =
      err.error_code === 429
        ? (err.parameters?.retry_after ?? undefined)
        : undefined;
    return new TelegramError(err.error_code, err.description, retryAfter);
  }

  static fromUnknown(err: unknown): TelegramError | Error {
    if (err instanceof TelegramError) {
      return err;
    }
    if (err instanceof GrammyError) {
      return TelegramError.fromGrammyError(err);
    }
    if (err instanceof HttpError) {
      return new TelegramError(0, `Network error: ${err.message}`);
    }
    if (err instanceof Error) {
      return err;
    }
    return new Error(String(err));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  fn: () => Promise<T>,
  logger: TelegramLogger,
  maxRetries = 3
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const wrapped = TelegramError.fromUnknown(err);

      if (wrapped instanceof TelegramError && wrapped.retryAfter) {
        const waitMs = wrapped.retryAfter * 1000;
        logger.warn(
          `Rate limited, retrying in ${wrapped.retryAfter}s (attempt ${attempt + 1}/${maxRetries + 1})`
        );
        await sleep(waitMs);
        continue;
      }

      if (wrapped instanceof TelegramError && wrapped.errorCode >= 500) {
        const backoff = Math.min(1000 * 2 ** attempt, 30_000);
        logger.warn(
          `Server error ${wrapped.errorCode}, retrying in ${backoff}ms (attempt ${attempt + 1}/${maxRetries + 1})`
        );
        await sleep(backoff);
        continue;
      }

      throw wrapped;
    }
  }

  throw TelegramError.fromUnknown(lastError);
};
