export type UnsupportedKind = "content" | "action";

interface UnsupportedErrorOptions {
  action?: string;
  contentType?: string;
  detail?: string;
  kind: UnsupportedKind;
  platform?: string;
}

const composeMessage = (opts: UnsupportedErrorOptions): string => {
  const platform = opts.platform ?? "platform";
  const subject =
    opts.kind === "content"
      ? `content type "${opts.contentType ?? "unknown"}"`
      : `action "${opts.action ?? "unknown"}"`;
  const detail = opts.detail ? `: ${opts.detail}` : "";
  return `${platform} does not support ${subject}${detail}`;
};

export class UnsupportedError extends Error {
  readonly kind: UnsupportedKind;
  readonly platform?: string;
  readonly contentType?: string;
  readonly action?: string;
  readonly detail?: string;

  constructor(opts: UnsupportedErrorOptions) {
    super(composeMessage(opts));
    this.name = "UnsupportedError";
    this.kind = opts.kind;
    this.platform = opts.platform;
    this.contentType = opts.contentType;
    this.action = opts.action;
    this.detail = opts.detail;
  }

  static content(
    contentType: string,
    platform?: string,
    detail?: string
  ): UnsupportedError {
    return new UnsupportedError({
      kind: "content",
      contentType,
      platform,
      detail,
    });
  }

  static action(
    action: string,
    platform?: string,
    detail?: string
  ): UnsupportedError {
    return new UnsupportedError({ kind: "action", action, platform, detail });
  }

  withPlatform(platform: string): UnsupportedError {
    if (this.platform) {
      return this;
    }
    return new UnsupportedError({
      kind: this.kind,
      platform,
      contentType: this.contentType,
      action: this.action,
      detail: this.detail,
    });
  }
}
