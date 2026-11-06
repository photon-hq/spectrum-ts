/** iLink's "session expired / token stale" code, returned as `ret` or `errcode`. */
export const SESSION_EXPIRED_CODE = -14;

interface WeChatApiErrorInit {
  endpoint: string;
  errcode?: number;
  errmsg?: string;
  ret?: number;
  /** HTTP status, for transport-level failures. */
  status?: number;
}

const describe = (init: WeChatApiErrorInit): string => {
  if (init.status !== undefined) {
    return `HTTP ${init.status}`;
  }
  const codes = [
    init.ret === undefined ? undefined : `ret=${init.ret}`,
    init.errcode === undefined ? undefined : `errcode=${init.errcode}`,
  ].filter(Boolean);
  const detail = init.errmsg ? `: ${init.errmsg}` : "";
  return `${codes.join(" ")}${detail}`;
};

/**
 * An iLink request failed, either at the HTTP layer (`status`) or with a
 * non-zero business code (`ret` / `errcode`). Messages never include the
 * response body or request headers, so they are safe to log.
 */
export class WeChatApiError extends Error {
  readonly endpoint: string;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly ret?: number;
  readonly status?: number;

  constructor(init: WeChatApiErrorInit, options?: ErrorOptions) {
    super(`WeChat ${init.endpoint} failed (${describe(init)})`, options);
    this.name = "WeChatApiError";
    this.endpoint = init.endpoint;
    this.errcode = init.errcode;
    this.errmsg = init.errmsg;
    this.ret = init.ret;
    this.status = init.status;
  }

  /** The bot session expired (code -14); scanning a new QR code fixes it. */
  get sessionExpired(): boolean {
    return (
      this.ret === SESSION_EXPIRED_CODE || this.errcode === SESSION_EXPIRED_CODE
    );
  }
}

/**
 * A send to `userId` was rejected and the provider holds no `context_token`
 * for that user — they have not messaged this bot since its state was last
 * saved. iLink ties replies to the user's latest inbound message; the user
 * has to message the bot again before it can reach them. `cause` carries the
 * server's rejection.
 */
export class WeChatContextTokenError extends Error {
  readonly userId: string;

  constructor(userId: string, options?: ErrorOptions) {
    super(
      `WeChat rejected a message to ${userId}: no context_token is cached for this user. iLink requires the user to message the bot first; ask them to send any message, then retry.`,
      options
    );
    this.name = "WeChatContextTokenError";
    this.userId = userId;
  }
}

/**
 * After a session-expired response the provider stops calling iLink for a
 * cool-down period (mirroring Tencent's client). Sends during that window
 * fail fast with this error instead of hitting the API.
 */
export class WeChatSessionPausedError extends Error {
  readonly resumesAt: Date;

  constructor(resumesAt: Date) {
    super(
      `WeChat session expired; API calls are paused until ${resumesAt.toISOString()}. Restart without a saved botToken to scan a new QR code.`
    );
    this.name = "WeChatSessionPausedError";
    this.resumesAt = resumesAt;
  }
}

/** The QR login flow ended without credentials. */
export class WeChatLoginError extends Error {
  /** The last QR status the server reported, when there was one. */
  readonly status?: string;

  constructor(message: string, status?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WeChatLoginError";
    this.status = status;
  }
}
