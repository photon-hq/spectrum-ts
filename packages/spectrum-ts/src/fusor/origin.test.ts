import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyFusorSignature } from "./origin";

const SECRET = "whsec_test";
const MISSING_HEADERS = /missing X-Spectrum-\* signature headers/;
const SIGNATURE_MISMATCH = /signature mismatch/;

// Mirror fanout-webhook's signer exactly: sign `v0:{ts}:` ++ rawBody as bytes.
const sign = (secret: string, ts: string, body: Uint8Array): string =>
  `v0=${createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`v0:${ts}:`, "utf8"), body]))
    .digest("hex")}`;

const headersFor = (ts: string, signature: string): Record<string, string> => ({
  "x-spectrum-timestamp": ts,
  "x-spectrum-signature": signature,
});

describe("verifyFusorSignature", () => {
  it("accepts a valid signature over a UTF-8 body", () => {
    const ts = "1700000000";
    const body = new TextEncoder().encode('{"event_id":"e1"}');
    expect(() =>
      verifyFusorSignature(SECRET, headersFor(ts, sign(SECRET, ts, body)), body)
    ).not.toThrow();
  });

  it("accepts a valid signature over a binary (non-UTF-8) body", () => {
    const ts = "123";
    const body = Uint8Array.from([0, 1, 2, 0xff, 0xfe]); // not valid UTF-8
    expect(() =>
      verifyFusorSignature(SECRET, headersFor(ts, sign(SECRET, ts, body)), body)
    ).not.toThrow();
  });

  it("rejects a tampered signature", () => {
    const ts = "1700000000";
    const body = new TextEncoder().encode("payload");
    const good = sign(SECRET, ts, body);
    const bad = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
    expect(() =>
      verifyFusorSignature(SECRET, headersFor(ts, bad), body)
    ).toThrow(SIGNATURE_MISMATCH);
  });

  it("rejects when the signed timestamp is swapped", () => {
    const body = new TextEncoder().encode("payload");
    const sig = sign(SECRET, "1700000000", body);
    // Same signature, different timestamp header → HMAC base differs.
    expect(() =>
      verifyFusorSignature(SECRET, headersFor("1700000001", sig), body)
    ).toThrow(SIGNATURE_MISMATCH);
  });

  it("rejects when the secret differs", () => {
    const ts = "1700000000";
    const body = new TextEncoder().encode("payload");
    expect(() =>
      verifyFusorSignature(
        SECRET,
        headersFor(ts, sign("other-secret", ts, body)),
        body
      )
    ).toThrow(SIGNATURE_MISMATCH);
  });

  it("throws when signature headers are missing", () => {
    const body = new TextEncoder().encode("payload");
    expect(() => verifyFusorSignature(SECRET, {}, body)).toThrow(
      MISSING_HEADERS
    );
    expect(() =>
      verifyFusorSignature(
        SECRET,
        { "x-spectrum-timestamp": "1700000000" },
        body
      )
    ).toThrow(MISSING_HEADERS);
  });
});
