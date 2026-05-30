import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies that an inbound webhook POST genuinely came from fusor's
// fanout-webhook delivery service. This is the OUTER signature
// (fusor → your server), distinct from the per-platform inner verify() that
// runs in `processEvent` (e.g. LinQ's HMAC over LinQ's own original body).
//
// Scheme, byte-identical to fusor's signer
// (apps/fanout-webhook/src/signing/sign.ts):
//
//   sigBase   = "v0:{timestamp}:" (utf8 bytes) ++ rawBody (the exact POST bytes)
//   signature = "v0=" + hex(HMAC-SHA256(webhookSecret, sigBase))   → X-Spectrum-Signature
//   {timestamp} is unix seconds, echoed in X-Spectrum-Timestamp.
//
// The body fusor POSTs is a protobuf `RawInboundEvent` (binary, not UTF-8), so
// the signed base MUST be built as bytes — concatenating a Uint8Array into a JS
// template string corrupts non-UTF-8 bytes. Verify over the raw received bytes,
// before decoding.

const SIGNATURE_HEADER = "x-spectrum-signature";
const TIMESTAMP_HEADER = "x-spectrum-timestamp";
const SIGNATURE_PREFIX = "v0=";

const stripPrefix = (value: string): string =>
  value.startsWith(SIGNATURE_PREFIX)
    ? value.slice(SIGNATURE_PREFIX.length)
    : value;

// Timing-safe hex comparison mirroring `packages/linq/src/verify.ts`: hex-decode
// both sides and reject on a length mismatch (or empty) before `timingSafeEqual`.
const safeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

/**
 * Verify fusor's `X-Spectrum-Signature` against the raw request body. Throws an
 * `Error` if the signature headers are missing or the signature doesn't match;
 * returns normally on success.
 *
 * `headers` keys MUST be lowercased. No timestamp-freshness check: fusor's
 * timestamp is "sign time" and can legitimately lag by minutes (head-of-line
 * blocking + retries reuse the same timestamp — see fanout-webhook/BEHAVIOR.md
 * §7a), and the timestamp is already bound by the HMAC, so rejecting on age would
 * only drop valid delayed deliveries.
 */
export const verifyFusorSignature = (
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array
): void => {
  const timestamp = headers[TIMESTAMP_HEADER];
  const signature = headers[SIGNATURE_HEADER];
  if (!(timestamp && signature)) {
    throw new Error("fusor webhook is missing X-Spectrum-* signature headers");
  }
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), body]);
  const expected =
    SIGNATURE_PREFIX + createHmac("sha256", secret).update(base).digest("hex");
  if (!safeEqualHex(stripPrefix(expected), stripPrefix(signature))) {
    throw new Error("fusor webhook signature mismatch");
  }
};
