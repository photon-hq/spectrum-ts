import { describe, expect, it } from "bun:test";
import { X_CLOUD_AUTH_BRAND, type XCloudAuth } from "@/providers/x/auth";
import { directConfigSchema } from "@/providers/x/config";
import { buildSignature } from "@/providers/x/signature";
import type { XPayload } from "@/providers/x/types";
import { makeVerify, verify } from "@/providers/x/verify";

const CONSUMER_SECRET = "consumer-secret";

const config = directConfigSchema.parse({
  consumerSecret: CONSUMER_SECRET,
  accessToken: "access-token",
  xUserId: "42",
  appBearerToken: "app-bearer-token",
});

const request = (
  method: string,
  path: string,
  body: string,
  headers: Record<string, string> = {}
) => ({
  method,
  path,
  headers,
  rawBody: new TextEncoder().encode(body),
});

describe("x verify", () => {
  it("parses GET crc challenge payloads", () => {
    const payload = verify(config)(
      request("GET", "/x?crc_token=abc123", "")
    ) as XPayload;
    expect(payload).toEqual({ type: "crc", crcToken: "abc123" });
  });

  it("rejects GET requests without crc_token", () => {
    expect(() => verify(config)(request("GET", "/x", ""))).toThrow("crc_token");
  });

  it("verifies POST signatures and parses JSON", () => {
    const body = JSON.stringify({ direct_message_events: [] });
    const rawBody = new TextEncoder().encode(body);
    const signature = buildSignature(rawBody, CONSUMER_SECRET);
    const payload = verify(config)(
      request("POST", "/x", body, {
        "x-twitter-webhooks-signature": signature,
      })
    ) as XPayload;
    expect(payload).toEqual({
      type: "dm",
      body: { direct_message_events: [] },
    });
  });

  it("rejects POST requests with missing signature", () => {
    expect(() =>
      verify(config)(request("POST", "/x", JSON.stringify({ hello: true })))
    ).toThrow("x-twitter-webhooks-signature");
  });

  it("rejects POST requests with invalid signature", () => {
    expect(() =>
      verify(config)(
        request("POST", "/x", JSON.stringify({ hello: true }), {
          "x-twitter-webhooks-signature": "sha256=wrong",
        })
      )
    ).toThrow("signature mismatch");
  });

  it("rejects POST requests with invalid JSON", () => {
    const body = "not-json";
    const signature = buildSignature(
      new TextEncoder().encode(body),
      CONSUMER_SECRET
    );
    expect(() =>
      verify(config)(
        request("POST", "/x", body, {
          "x-twitter-webhooks-signature": signature,
        })
      )
    ).toThrow("not valid JSON");
  });

  it("rejects unsupported HTTP methods", () => {
    expect(() => verify(config)(request("PUT", "/x", ""))).toThrow(
      "does not support method"
    );
  });
});

describe("x makeVerify", () => {
  const cloudAuth: XCloudAuth = {
    [X_CLOUD_AUTH_BRAND]: true,
    dispose: () => {},
    getAccessToken: async () => "cloud-access-token",
    getConsumerSecret: async () => CONSUMER_SECRET,
    getXUserId: () => "42",
  };

  it("parses GET crc challenge payloads using cloud consumerSecret", async () => {
    const payload = (await makeVerify(cloudAuth)(
      request("GET", "/x?crc_token=cloud-crc", "")
    )) as XPayload;
    expect(payload).toEqual({ type: "crc", crcToken: "cloud-crc" });
  });

  it("verifies POST signatures using cloud consumerSecret", async () => {
    const body = JSON.stringify({ direct_message_events: [] });
    const rawBody = new TextEncoder().encode(body);
    const signature = buildSignature(rawBody, CONSUMER_SECRET);
    const payload = (await makeVerify(cloudAuth)(
      request("POST", "/x", body, {
        "x-twitter-webhooks-signature": signature,
      })
    )) as XPayload;
    expect(payload).toEqual({
      type: "dm",
      body: { direct_message_events: [] },
    });
  });

  it("prefers consumerSecret override over cloud auth", async () => {
    const overrideSecret = "override-consumer-secret";
    const body = JSON.stringify({ direct_message_events: [] });
    const rawBody = new TextEncoder().encode(body);
    const signature = buildSignature(rawBody, overrideSecret);
    const authWithDifferentSecret: XCloudAuth = {
      ...cloudAuth,
      getConsumerSecret: async () => "wrong-secret",
    };
    const payload = (await makeVerify(
      authWithDifferentSecret,
      overrideSecret
    )(
      request("POST", "/x", body, {
        "x-twitter-webhooks-signature": signature,
      })
    )) as XPayload;
    expect(payload).toEqual({
      type: "dm",
      body: { direct_message_events: [] },
    });
  });
});
