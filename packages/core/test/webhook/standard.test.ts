import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseHttpRequest } from "@/fusor/parse";
import {
  parseStandardWebhookEvent,
  standardWebhookToRawInboundEvent,
  verifyStandardWebhookSignature,
} from "@/webhook/standard";

const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const SECRET_BYTES = Buffer.alloc(32, 0x2a);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value)
  );

const sign = (
  body: Uint8Array,
  messageId = "evt_1",
  timestamp = NOW_SECONDS,
  secret = SECRET_BYTES
): string => {
  const base = Buffer.concat([
    Buffer.from(`${messageId}.${timestamp}.`, "utf8"),
    Buffer.from(body),
  ]);
  return `v1,${createHmac("sha256", secret).update(base).digest("base64")}`;
};

const headersFor = (
  body: Uint8Array,
  overrides: Record<string, string> = {}
): Record<string, string> => ({
  "webhook-id": "evt_1",
  "webhook-signature": sign(body),
  "webhook-timestamp": String(NOW_SECONDS),
  ...overrides,
});

describe("verifyStandardWebhookSignature", () => {
  it("matches the Standard Webhooks v1 reference vector", () => {
    const body = encode('{"test": 2432232314}');
    const result = verifyStandardWebhookSignature({
      headers: {
        "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
        "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        "webhook-timestamp": "1614265330",
      },
      now: 1_614_265_330_000,
      rawBody: body,
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    });
    expect(result).toEqual({
      messageId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      ok: true,
      timestamp: 1_614_265_330,
    });
  });

  it("accepts a correctly signed exact body", () => {
    const body = encode('{"type":"message.received"}');
    expect(
      verifyStandardWebhookSignature({
        headers: headersFor(body),
        now: NOW_MS,
        rawBody: body,
        secret: SECRET,
      })
    ).toEqual({ messageId: "evt_1", ok: true, timestamp: NOW_SECONDS });
  });

  it("matches header names case-insensitively", () => {
    const body = encode("payload");
    const headers = new Headers({
      "Webhook-Id": "evt_1",
      "Webhook-Signature": sign(body),
      "Webhook-Timestamp": String(NOW_SECONDS),
    });
    expect(
      verifyStandardWebhookSignature({
        headers,
        now: NOW_MS,
        rawBody: body,
        secret: SECRET,
      }).ok
    ).toBe(true);
  });

  it("accepts the matching signature during rotation", () => {
    const body = encode("payload");
    const wrong = `v1,${Buffer.alloc(32, 0x11).toString("base64")}`;
    const headers = headersFor(body, {
      "webhook-signature": `${wrong} ${sign(body)}`,
    });
    expect(
      verifyStandardWebhookSignature({
        headers,
        now: NOW_MS,
        rawBody: body,
        secret: SECRET,
      }).ok
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signedBody = encode("original");
    const result = verifyStandardWebhookSignature({
      headers: headersFor(signedBody),
      now: NOW_MS,
      rawBody: encode("tampered"),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects timestamps outside the replay window", () => {
    const body = encode("payload");
    const timestamp = NOW_SECONDS - 301;
    const result = verifyStandardWebhookSignature({
      headers: headersFor(body, {
        "webhook-signature": sign(body, "evt_1", timestamp),
        "webhook-timestamp": String(timestamp),
      }),
      now: NOW_MS,
      rawBody: body,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects missing or malformed headers", () => {
    const body = encode("payload");
    expect(
      verifyStandardWebhookSignature({
        headers: {},
        now: NOW_MS,
        rawBody: body,
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "missing-headers" });
    expect(
      verifyStandardWebhookSignature({
        headers: headersFor(body, { "webhook-timestamp": "NaN" }),
        now: NOW_MS,
        rawBody: body,
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "invalid-headers" });
    expect(
      verifyStandardWebhookSignature({
        headers: headersFor(body, { "webhook-id": "event.with.period" }),
        now: NOW_MS,
        rawBody: body,
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "invalid-headers" });
  });

  it("rejects a malformed whsec secret", () => {
    const body = encode("payload");
    expect(
      verifyStandardWebhookSignature({
        headers: headersFor(body),
        now: NOW_MS,
        rawBody: body,
        secret: "whsec_not-base64",
      })
    ).toEqual({ ok: false, reason: "invalid-secret" });
  });
});

describe("parseStandardWebhookEvent", () => {
  it("validates the event and reconstructs the original provider request", () => {
    const providerBody = encode('{"type":"message","text":"hello"}');
    const rawBodyBase64 = Buffer.from(providerBody).toString("base64");
    const event = parseStandardWebhookEvent(
      encode({
        eventId: "evt_1",
        platform: "slack",
        prevSubjectSeq: 12,
        projectId: "proj_1",
        receivedAt: "2026-08-03T20:00:00.000Z",
        request: {
          body: { text: "hello", type: "message" },
          bodyEncoding: "json",
          headers: { "content-type": "application/json", "x-provider": "1" },
          method: "POST",
          path: "/events?source=test",
          rawBodyBase64,
        },
        schemaVersion: 1,
        sourceId: "source_1",
        timestamp: "2026-08-03T20:00:00.000Z",
        type: "message.received",
      })
    );
    const inbound = standardWebhookToRawInboundEvent(event);
    const parsedRequest = parseHttpRequest(inbound.rawRequest);

    expect(inbound).toMatchObject({
      eventId: "evt_1",
      platform: "slack",
      prevSubjectSeq: 12,
      projectId: "proj_1",
      sourceId: "source_1",
    });
    expect(inbound.receivedAt?.toISOString()).toBe("2026-08-03T20:00:00.000Z");
    expect(parsedRequest).toMatchObject({
      headers: { "content-type": "application/json", "x-provider": "1" },
      method: "POST",
      path: "/events?source=test",
    });
    expect(Buffer.from(parsedRequest.rawBody)).toEqual(
      Buffer.from(providerBody)
    );
  });

  it("rejects injected request headers", () => {
    expect(() =>
      parseStandardWebhookEvent(
        encode({
          eventId: "evt_1",
          platform: "slack",
          prevSubjectSeq: 0,
          projectId: "proj_1",
          request: {
            body: "",
            bodyEncoding: "text",
            headers: { "x-test": "ok\r\nx-injected: true" },
            method: "POST",
            path: "/events",
            rawBodyBase64: "",
          },
          schemaVersion: 1,
          type: "message.received",
        })
      )
    ).toThrow();
  });
});
