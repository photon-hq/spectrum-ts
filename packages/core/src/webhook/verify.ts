import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER = "x-spectrum-signature";
const TIMESTAMP_HEADER = "x-spectrum-timestamp";
const SIGNATURE_PREFIX = "v0=";
const SIGNATURE_SCHEME = "v0";

/**
 * Replay-protection window, in seconds. Spectrum signs each delivery with a
 * timestamp; a delivery whose timestamp is further than this from now (past or
 * future) is rejected, so a captured request cannot be replayed indefinitely.
 * Matches the documented 5-minute tolerance.
 */
const REPLAY_TOLERANCE_SECONDS = 300;
const MILLIS_PER_SECOND = 1000;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing-headers" | "expired" | "signature-mismatch" };

export interface VerifyInput {
  /** Request headers, keys lowercased. */
  headers: Record<string, string>;
  /** Epoch milliseconds; injectable for deterministic tests. */
  now?: number;
  /** The exact bytes received on the wire — never a re-encoded body. */
  rawBody: Uint8Array;
  /** The per-webhook signing secret. */
  secret: string;
}

/**
 * Verify a native Spectrum webhook signature.
 *
 * The header is `X-Spectrum-Signature: v0=<lowercase-hex>` where the hex digest
 * is `HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)` and `timestamp`
 * is the `X-Spectrum-Timestamp` header (unix seconds). The base string is built
 * over the **exact body bytes**: never JSON-parse-then-restringify before
 * verifying, or the bytes (key order, whitespace) change and the MAC won't
 * match. The digest comparison is constant-time.
 */
export function verifySpectrumSignature(input: VerifyInput): VerifyResult {
  const { rawBody, headers, secret, now = Date.now() } = input;
  const provided = headers[SIGNATURE_HEADER];
  const timestamp = headers[TIMESTAMP_HEADER];
  if (!(provided && timestamp)) {
    return { ok: false, reason: "missing-headers" };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "missing-headers" };
  }
  const nowSeconds = Math.floor(now / MILLIS_PER_SECOND);
  if (Math.abs(nowSeconds - timestampSeconds) > REPLAY_TOLERANCE_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  const base = Buffer.concat([
    Buffer.from(`${SIGNATURE_SCHEME}:${timestamp}:`, "utf8"),
    Buffer.from(rawBody),
  ]);
  const expected = createHmac("sha256", secret).update(base).digest();

  const providedHex = provided.startsWith(SIGNATURE_PREFIX)
    ? provided.slice(SIGNATURE_PREFIX.length)
    : provided;
  const providedBytes = Buffer.from(providedHex, "hex");
  if (
    providedBytes.length !== expected.length ||
    !timingSafeEqual(providedBytes, expected)
  ) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true };
}
