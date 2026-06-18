import { createHmac } from "node:crypto";

// A fixed per-webhook signing secret for the native Spectrum webhook tests.
export const SPECTRUM_WEBHOOK_SECRET =
  "whsec_test_0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const MILLIS_PER_SECOND = 1000;

export interface SignedSpectrumWebhook {
  body: Uint8Array;
  headers: Record<string, string>;
}

export interface SignSpectrumOptions {
  event?: string;
  secret?: string;
  /**
   * Sign over these bytes instead of the encoded payload — used to simulate a
   * tampered body (signature computed over different bytes than delivered).
   */
  signOver?: Uint8Array;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  webhookId?: string;
}

const encode = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(
    typeof payload === "string" ? payload : JSON.stringify(payload)
  );

/**
 * Build a signed native Spectrum webhook request exactly as the SDK verifies it:
 * `HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)`, hex, `v0=` prefix.
 */
export const signSpectrum = (
  payload: unknown,
  opts: SignSpectrumOptions = {}
): SignedSpectrumWebhook => {
  const secret = opts.secret ?? SPECTRUM_WEBHOOK_SECRET;
  const timestamp =
    opts.timestamp ?? Math.floor(Date.now() / MILLIS_PER_SECOND);
  const body = encode(payload);
  const signedOver = opts.signOver ?? body;
  const base = Buffer.concat([
    Buffer.from(`v0:${timestamp}:`, "utf8"),
    Buffer.from(signedOver),
  ]);
  const hex = createHmac("sha256", secret).update(base).digest("hex");
  return {
    headers: {
      "x-spectrum-event": opts.event ?? "messages",
      "x-spectrum-signature": `v0=${hex}`,
      "x-spectrum-timestamp": String(timestamp),
      "x-spectrum-webhook-id": opts.webhookId ?? "wh-1",
      "content-type": "application/json",
    },
    body,
  };
};

/** A minimal native `messages` envelope for a text message on `platform`. */
export const textEnvelope = (
  platform: string,
  text: string,
  overrides: Record<string, unknown> = {}
) => ({
  event: "messages",
  space: { id: "s1", platform },
  message: {
    id: "m-webhook-1",
    platform,
    direction: "inbound",
    timestamp: "2026-06-12T10:00:00.000Z",
    sender: { id: "u1", platform },
    space: { id: "s1", platform },
    content: { type: "text", text },
    ...overrides,
  },
});
