import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySpectrumSignature } from "@/webhook/verify";

const SECRET = "whsec_unit_test_secret";
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const TOLERANCE_SECONDS = 300;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// Independently compute the signature header the way the docs specify, so the
// test is a real known-answer check rather than calling the impl twice.
const sign = (body: Uint8Array, timestamp: number, secret = SECRET): string => {
  const base = Buffer.concat([
    Buffer.from(`v0:${timestamp}:`, "utf8"),
    Buffer.from(body),
  ]);
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
};

const headersFor = (
  signature: string,
  timestamp: number
): Record<string, string> => ({
  "x-spectrum-signature": signature,
  "x-spectrum-timestamp": String(timestamp),
});

describe("verifySpectrumSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = encode('{"event":"messages"}');
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: headersFor(sign(body, NOW_SECONDS), NOW_SECONDS),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a bare hex signature without the v0= prefix", () => {
    const body = encode("payload");
    const signature = sign(body, NOW_SECONDS).slice("v0=".length);
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: headersFor(signature, NOW_SECONDS),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signedBody = encode("original");
    const deliveredBody = encode("tampered!");
    const result = verifySpectrumSignature({
      rawBody: deliveredBody,
      headers: headersFor(sign(signedBody, NOW_SECONDS), NOW_SECONDS),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects a wrong secret", () => {
    const body = encode("payload");
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: headersFor(sign(body, NOW_SECONDS, "other-secret"), NOW_SECONDS),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("accepts a timestamp at the edge of the tolerance window", () => {
    const body = encode("payload");
    const timestamp = NOW_SECONDS - TOLERANCE_SECONDS;
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: headersFor(sign(body, timestamp), timestamp),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a timestamp just outside the tolerance window", () => {
    const body = encode("payload");
    const timestamp = NOW_SECONDS - TOLERANCE_SECONDS - 1;
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: headersFor(sign(body, timestamp), timestamp),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects when the signature header is missing", () => {
    const body = encode("payload");
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: { "x-spectrum-timestamp": String(NOW_SECONDS) },
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing-headers" });
  });

  it("rejects when the timestamp header is missing", () => {
    const body = encode("payload");
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: { "x-spectrum-signature": sign(body, NOW_SECONDS) },
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing-headers" });
  });

  it("rejects a non-numeric timestamp header", () => {
    const body = encode("payload");
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: {
        "x-spectrum-signature": sign(body, NOW_SECONDS),
        "x-spectrum-timestamp": "not-a-number",
      },
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing-headers" });
  });

  it("rejects a non-hex / wrong-length signature without throwing", () => {
    const body = encode("payload");
    const result = verifySpectrumSignature({
      rawBody: body,
      headers: headersFor("v0=not-hex-zzzz", NOW_SECONDS),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
  });
});
