import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { configSchema } from "../src/config";
import type { LinqPayload } from "../src/types";
import { makeVerify } from "../src/verify";

const SECRET = "whsec_test";

const body = (eventType: string): string =>
  JSON.stringify({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: eventType,
    event_id: "evt-1",
    created_at: "2026-05-29T00:00:00Z",
    trace_id: "t",
    partner_id: "p",
    data: { chat: { id: "c1" }, id: "m1", parts: [] },
  });

const sign = (timestamp: string, payload: string): string =>
  createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex");

const nowSec = (): string => String(Math.floor(Date.now() / 1000));

const request = (
  payload: string,
  headers: Record<string, string>
): {
  headers: Record<string, string>;
  method: string;
  path: string;
  rawBody: Uint8Array;
} => ({
  headers,
  method: "POST",
  path: "/linq",
  rawBody: new TextEncoder().encode(payload),
});

describe("makeVerify", () => {
  it("accepts a correctly signed, fresh webhook", () => {
    const verify = makeVerify(
      configSchema.parse({ apiKey: "k", webhookSigningSecret: SECRET })
    );
    const payload = body("message.received");
    const ts = nowSec();
    const result = verify(
      request(payload, {
        "x-webhook-timestamp": ts,
        "x-webhook-signature": sign(ts, payload),
      })
    ) as LinqPayload;
    expect(result.event_type).toBe("message.received");
    expect(result.event_id).toBe("evt-1");
  });

  it("rejects a tampered body", () => {
    const verify = makeVerify(
      configSchema.parse({ apiKey: "k", webhookSigningSecret: SECRET })
    );
    const payload = body("message.received");
    const ts = nowSec();
    const signature = sign(ts, payload);
    expect(() =>
      verify(
        request(body("reaction.added"), {
          "x-webhook-timestamp": ts,
          "x-webhook-signature": signature,
        })
      )
    ).toThrow("signature mismatch");
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const verify = makeVerify(
      configSchema.parse({
        apiKey: "k",
        webhookSigningSecret: SECRET,
        replayToleranceSec: 60,
      })
    );
    const payload = body("message.received");
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    expect(() =>
      verify(
        request(payload, {
          "x-webhook-timestamp": ts,
          "x-webhook-signature": sign(ts, payload),
        })
      )
    ).toThrow("tolerance");
  });

  it("rejects when signature headers are missing but a secret is set", () => {
    const verify = makeVerify(
      configSchema.parse({ apiKey: "k", webhookSigningSecret: SECRET })
    );
    expect(() => verify(request(body("message.received"), {}))).toThrow(
      "missing signature headers"
    );
  });

  it("skips verification when no signing secret is configured", () => {
    const verify = makeVerify(configSchema.parse({ apiKey: "k" }));
    const result = verify(request(body("message.received"), {})) as LinqPayload;
    expect(result.event_type).toBe("message.received");
  });

  it("rejects a body that is not valid JSON", () => {
    const verify = makeVerify(configSchema.parse({ apiKey: "k" }));
    expect(() => verify(request("not json", {}))).toThrow("not valid JSON");
  });

  it("rejects a payload missing event_type", () => {
    const verify = makeVerify(configSchema.parse({ apiKey: "k" }));
    expect(() => verify(request(JSON.stringify({ data: {} }), {}))).toThrow(
      "missing event_type"
    );
  });
});
