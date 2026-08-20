import { subtle } from "uncrypto";

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

const HEX_PATTERN = /^[0-9a-f]+$/i;
const HEX_CHARS_PER_BYTE = 2;
const HEX_RADIX = 16;

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

/** Strict hex decode; `null` (not a truncated buffer) on malformed input. */
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (
    hex.length === 0 ||
    hex.length % HEX_CHARS_PER_BYTE !== 0 ||
    !HEX_PATTERN.test(hex)
  ) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / HEX_CHARS_PER_BYTE);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * HEX_CHARS_PER_BYTE;
    bytes[index] = Number.parseInt(
      hex.slice(offset, offset + HEX_CHARS_PER_BYTE),
      HEX_RADIX
    );
  }
  return bytes;
};

/**
 * Verify a native Spectrum webhook signature.
 *
 * The header is `X-Spectrum-Signature: v0=<lowercase-hex>` where the hex digest
 * is `HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)` and `timestamp`
 * is the `X-Spectrum-Timestamp` header (unix seconds). The base string is built
 * over the **exact body bytes**: never JSON-parse-then-restringify before
 * verifying, or the bytes (key order, whitespace) change and the MAC won't
 * match.
 *
 * Implemented on Web Crypto (hence async) so it runs identically on Node, Bun,
 * and V8-isolate runtimes (Convex, Cloudflare Workers, Deno Deploy) — this is
 * part of the portable `@spectrum-ts/core/webhook` entry. `subtle` comes from
 * `uncrypto`, whose conditional exports pick `node:crypto`'s webcrypto under
 * Node and `globalThis.crypto` everywhere else, so this works on Node 18 (where
 * the global is not exposed by default) without a runtime feature check.
 *
 * The digest comparison is `subtle.verify`, which compares MACs in constant
 * time.
 */
export async function verifySpectrumSignature(
  input: VerifyInput
): Promise<VerifyResult> {
  const { rawBody, headers, secret, now = Date.now() } = input;
  if (!secret) {
    // A missing secret is caller misconfiguration, not an unauthenticated
    // request — surface it loudly instead of returning an undebuggable 401.
    throw new Error("verifySpectrumSignature: secret must be non-empty");
  }
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

  const providedHex = provided.startsWith(SIGNATURE_PREFIX)
    ? provided.slice(SIGNATURE_PREFIX.length)
    : provided;
  const providedBytes = hexToBytes(providedHex);
  if (!providedBytes) {
    return { ok: false, reason: "signature-mismatch" };
  }

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${SIGNATURE_SCHEME}:${timestamp}:`);
  const base = new Uint8Array(prefix.length + rawBody.length);
  base.set(prefix, 0);
  base.set(rawBody, prefix.length);

  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const matches = await subtle.verify("HMAC", key, providedBytes, base);
  if (!matches) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true };
}
