import { X_PLATFORM, type XConfig } from "./config";

/**
 * Base domain of the Fusor "super webhook" edge. X delivers events to
 * `https://{slug}.{domain}/{platform}`, where Fusor forwards them on to
 * Spectrum. Override per-environment via `SPECTRUM_SUPER_WEBHOOK`.
 */
const DEFAULT_SUPER_WEBHOOK_DOMAIN = "spctrm.dev";

interface XWebhookRecord {
  id: string;
  url: string;
}

interface XApiResult {
  body: unknown;
  status: number;
}

const authHeader = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const pickFirstString = (
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return;
};

const extractXErrorMessage = (status: number, payload: unknown): string => {
  if (!(payload && typeof payload === "object")) {
    return `X API error: ${status}`;
  }
  const body = payload as Record<string, unknown>;
  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (!(entry && typeof entry === "object")) {
        continue;
      }
      const fromEntry = pickFirstString(entry as Record<string, unknown>, [
        "detail",
        "message",
        "title",
      ]);
      if (fromEntry) {
        return fromEntry;
      }
    }
  }
  const detail = pickFirstString(body, ["detail", "title", "message"]);
  if (detail) {
    return detail;
  }
  return `X API error: ${status}`;
};

const requestX = async (
  url: string,
  init: RequestInit
): Promise<XApiResult> => {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

const expectOk = (result: XApiResult, context: string): void => {
  if (result.status >= 200 && result.status < 300) {
    return;
  }
  throw new Error(
    `${context}: ${extractXErrorMessage(result.status, result.body)}`
  );
};

const asWebhookRecord = (value: unknown): XWebhookRecord | undefined => {
  if (!(value && typeof value === "object")) {
    return;
  }
  const record = value as Record<string, unknown>;
  const id = pickFirstString(record, ["id", "webhook_id"]);
  const url = pickFirstString(record, ["url"]);
  if (!(id && url)) {
    return;
  }
  return { id, url };
};

const extractWebhookList = (payload: unknown): XWebhookRecord[] => {
  if (!(payload && typeof payload === "object")) {
    return [];
  }
  const body = payload as Record<string, unknown>;
  const candidates = [body.data, body.webhooks];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const parsed = candidate
      .map((entry) => asWebhookRecord(entry))
      .filter((entry): entry is XWebhookRecord => Boolean(entry));
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
};

const extractWebhookId = (payload: unknown): string | undefined => {
  if (!(payload && typeof payload === "object")) {
    return;
  }
  const body = payload as Record<string, unknown>;
  const topLevel = pickFirstString(body, ["id", "webhook_id"]);
  if (topLevel) {
    return topLevel;
  }
  if (body.data && typeof body.data === "object") {
    return pickFirstString(body.data as Record<string, unknown>, [
      "id",
      "webhook_id",
    ]);
  }
  return;
};

const subscribeWebhook = async (
  config: XConfig,
  webhookId: string
): Promise<void> => {
  const result = await requestX(
    `${config.baseUrl}/2/account_activity/webhooks/${encodeURIComponent(webhookId)}/subscriptions/all`,
    {
      method: "POST",
      headers: authHeader(config.accessToken),
    }
  );
  if (result.status === 409) {
    return;
  }
  expectOk(result, "X account subscription failed");
};

/**
 * The webhook URL X should deliver account-activity events to: the Fusor edge
 * keyed by the project `slug`, on the X platform path segment.
 */
export const webhookUrl = (slug: string): string => {
  const domain =
    process.env.SPECTRUM_SUPER_WEBHOOK ?? DEFAULT_SUPER_WEBHOOK_DOMAIN;
  return `https://${slug}.${domain}/${X_PLATFORM}`;
};

/**
 * Ensure X account-activity delivery targets the Fusor edge for `slug`.
 *
 * Idempotent: lists existing webhooks and reuses a matching URL before
 * creating a new one, then subscribes the connected account. Subscription
 * `409` is treated as already subscribed. Failures throw a token-free error,
 * failing `Spectrum()` startup fast.
 */
export const ensureWebhook = async (
  config: XConfig,
  slug: string
): Promise<void> => {
  const url = webhookUrl(slug);
  try {
    const listed = await requestX(`${config.baseUrl}/2/webhooks`, {
      method: "GET",
      headers: authHeader(config.appBearerToken),
    });
    expectOk(listed, "X webhook list failed");

    const existing = extractWebhookList(listed.body).find(
      (entry) => entry.url === url
    );

    let webhookId = existing?.id;
    if (!webhookId) {
      const created = await requestX(`${config.baseUrl}/2/webhooks`, {
        method: "POST",
        headers: {
          ...authHeader(config.appBearerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      expectOk(created, "X webhook creation failed");
      webhookId = extractWebhookId(created.body);
      if (!webhookId) {
        throw new Error("X webhook creation response is missing webhook id");
      }
    }

    await subscribeWebhook(config, webhookId);
  } catch (error) {
    throw new Error(`X webhook registration failed for ${url}`, {
      cause: error,
    });
  }
};
