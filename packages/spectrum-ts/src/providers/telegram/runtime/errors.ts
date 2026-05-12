import type { ResponseParameters } from "../generated/types";

export interface TelegramApiErrorOptions {
  description: string;
  errorCode: number;
  method: string;
  parameters?: ResponseParameters;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number;
  readonly description: string;
  readonly parameters?: ResponseParameters;

  constructor(opts: TelegramApiErrorOptions) {
    super(
      `Telegram ${opts.method} failed (${opts.errorCode}): ${opts.description}`
    );
    this.name = "TelegramApiError";
    this.method = opts.method;
    this.errorCode = opts.errorCode;
    this.description = opts.description;
    this.parameters = opts.parameters;
  }

  get isRateLimit(): boolean {
    return this.errorCode === 429;
  }

  get isServerError(): boolean {
    return this.errorCode >= 500 && this.errorCode < 600;
  }

  get isClientError(): boolean {
    return (
      this.errorCode >= 400 && this.errorCode < 500 && this.errorCode !== 429
    );
  }

  get retryAfter(): number | undefined {
    return this.parameters?.retry_after;
  }

  get migrateToChatId(): number | undefined {
    return this.parameters?.migrate_to_chat_id;
  }
}

export class TelegramNetworkError extends Error {
  readonly method: string;

  constructor(method: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Telegram ${method} network error: ${reason}`, { cause });
    this.name = "TelegramNetworkError";
    this.method = method;
  }
}
