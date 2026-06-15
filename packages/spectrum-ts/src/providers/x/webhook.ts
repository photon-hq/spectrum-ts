import {
  DEFAULT_BASE_URL,
  X_PLATFORM,
  type XEnsureWebhookInput,
} from "./config";

/**
 * Base domain of the Fusor "super webhook" edge. X delivers events to
 * `https://{slug}.{domain}/{platform}`, where Fusor forwards them on to
 * Spectrum. Override per-environment via `SPECTRUM_SUPER_WEBHOOK`.
 */
const DEFAULT_SUPER_WEBHOOK_DOMAIN = "spctrm.dev";

const TRAILING_SLASH = /\/$/;

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

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

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
      const e = entry as Record<string, unknown>;
      const fromEntry = asStr(e.detail) ?? asStr(e.message) ?? asStr(e.title);
      if (fromEntry) {
        return fromEntry;
      }
    }
  }
  const detail = asStr(body.detail) ?? asStr(body.title) ?? asStr(body.message);
  return detail ?? `X API error: ${status}`;
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
  const id = asStr(record.id) ?? asStr(record.webhook_id);
  const url = asStr(record.url);
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
  const id = asStr(body.id) ?? asStr(body.webhook_id);
  if (id) {
    return id;
  }
  if (body.data && typeof body.data === "object") {
    const data = body.data as Record<string, unknown>;
    return asStr(data.id) ?? asStr(data.webhook_id);
  }
};

const isAlreadySubscribed = (result: XApiResult): boolean => {
  if (result.status === 409) {
    return true;
  }
  const message = extractXErrorMessage(result.status, result.body);
  return (
    message.includes("Subscription already exists") ||
    message.includes("DuplicateSubscription")
  );
};

const subscribeWebhook = async (
  input: XEnsureWebhookInput,
  webhookId: string
): Promise<void> => {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const result = await requestX(
    `${baseUrl}/2/account_activity/webhooks/${encodeURIComponent(webhookId)}/subscriptions/all`,
    {
      method: "POST",
      headers: authHeader(input.accessToken),
    }
  );
  if (isAlreadySubscribed(result)) {
    return;
  }
  expectOk(result, "X account subscription failed");
};

/**
 * The webhook URL X should deliver account-activity events to: the Fusor edge
 * keyed by the project `slug`, on the X platform path segment.
 */
export const webhookUrl = (slug: string, webhookBaseUrl?: string): string => {
  const override =
    webhookBaseUrl?.trim() || process.env.X_FUSOR_WEBHOOK_URL_OVERRIDE?.trim();
  if (override) {
    return `${override.replace(TRAILING_SLASH, "")}/${X_PLATFORM}`;
  }

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
 *
 * @param input - The input object containing the app bearer token, access token, and base URL.
 * @param slug - The slug of the project.
 * @param webhookBaseUrl - The base URL of the webhook. Typically this is the url of the webhook.
 * @returns A promise that resolves when the webhook is created and subscribed.
 */
export const ensureWebhook = async (
  input: XEnsureWebhookInput,
  slug: string,
  webhookBaseUrl?: string
): Promise<void> => {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const url = webhookUrl(slug, webhookBaseUrl);
  try {
    const listed = await requestX(`${baseUrl}/2/webhooks`, {
      method: "GET",
      headers: authHeader(input.appBearerToken),
    });
    expectOk(listed, "X webhook list failed");

    const existing = extractWebhookList(listed.body).find(
      (entry) => entry.url === url
    );

    // Create Webhook on X API which is the https://{slug}.{domain}/{platform}

    
    let webhookId = existing?.id;
    if (!webhookId) {
      const created = await requestX(`${baseUrl}/2/webhooks`, {
        method: "POST",
        headers: {
          ...authHeader(input.appBearerToken),
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

    await subscribeWebhook(input, webhookId);
  } catch (error) {
    throw new Error(`X webhook registration failed for ${url}`, {
      cause: error,
    });
  }
};
