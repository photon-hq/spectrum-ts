import { createHmac } from "node:crypto";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { encodeEvent, makeSlack } from "@spectrum-ts/test-support/fusor";
import {
  baseConfig,
  makeManagedProvider,
} from "@spectrum-ts/test-support/platform";
import { flush } from "@spectrum-ts/test-support/timing";
import {
  SPECTRUM_WEBHOOK_SECRET,
  signSpectrum,
  textEnvelope,
} from "@spectrum-ts/test-support/webhook";
import { describe, expect, it } from "vitest";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";

stubCloud();

// The env fallback must not leak in from the host so the missing-secret path is
// exercised deterministically (empty string is falsy → treated as unset).
process.env.SPECTRUM_WEBHOOK_SECRET = "";

const PLATFORM = "im";
const NO_FUSOR_PROVIDER_ERROR = /no fusor provider is configured/;
const LEGACY_WEBHOOK_SECRET = "0123456789abcdef".repeat(4);
const STANDARD_SECRET_BYTES = Buffer.alloc(32, 0x2a);
const STANDARD_WEBHOOK_SECRET = `whsec_${STANDARD_SECRET_BYTES.toString("base64")}`;

const standardPayload = (
  providerBody: Record<string, unknown>,
  eventId = "evt-standard-1"
) => ({
  eventId,
  platform: "slack",
  prevSubjectSeq: 1,
  projectId: "proj",
  receivedAt: "2026-08-03T20:00:00.000Z",
  request: {
    body: providerBody,
    bodyEncoding: "json" as const,
    headers: { "content-type": "application/json" },
    method: "POST",
    path: "/slack",
    rawBodyBase64: Buffer.from(JSON.stringify(providerBody)).toString("base64"),
  },
  schemaVersion: 1 as const,
  timestamp: "2026-08-03T20:00:00.000Z",
  type: "message.received" as const,
});

const signStandardDelivery = (
  payload: ReturnType<typeof standardPayload>,
  secret = STANDARD_SECRET_BYTES
) => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = Math.floor(Date.now() / 1000);
  const base = Buffer.concat([
    Buffer.from(`${payload.eventId}.${timestamp}.`, "utf8"),
    Buffer.from(body),
  ]);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": payload.eventId,
      "webhook-signature": `v1,${createHmac("sha256", secret)
        .update(base)
        .digest("base64")}`,
      "webhook-timestamp": String(timestamp),
    },
  };
};

const withSpectrum = async (
  overrides: Record<string, unknown>,
  fn: (spectrum: Awaited<ReturnType<typeof Spectrum>>) => Promise<void>
) => {
  const spectrum = await Spectrum({
    ...baseConfig,
    providers: [makeManagedProvider(PLATFORM).config({})],
    ...overrides,
  });
  try {
    await fn(spectrum);
  } finally {
    await spectrum.stop();
  }
};

describe("spectrum.webhook (native Spectrum webhook)", () => {
  it("verifies, deserializes, and delivers a signed message", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        const received: [unknown, Message][] = [];
        const { promise: finished, resolve: done } =
          Promise.withResolvers<void>();

        const signed = signSpectrum(textEnvelope(PLATFORM, "hello there"));
        const result = await spectrum.webhook(signed, (space, message) => {
          received.push([space, message]);
          done();
        });
        await finished;

        expect(result.status).toBe(200);
        expect(received).toHaveLength(1);
        const [space, message] = received[0] ?? [];
        expect((space as { __platform: string }).__platform).toBe(PLATFORM);
        expect(message?.direction).toBe("inbound");
        expect(message?.content).toEqual({ type: "text", text: "hello there" });
      }
    );
  });

  it("rejects a bad signature with 401 and never calls the handler", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        let called = false;
        const signed = signSpectrum(textEnvelope(PLATFORM, "hi"), {
          secret: "the-wrong-secret",
        });
        const result = await spectrum.webhook(signed, () => {
          called = true;
        });
        await flush();

        expect(result.status).toBe(401);
        expect(called).toBe(false);
      }
    );
  });

  it("rejects an expired timestamp with 401", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        const signed = signSpectrum(textEnvelope(PLATFORM, "hi"), {
          timestamp: Math.floor(Date.now() / 1000) - 1000,
        });
        const result = await spectrum.webhook(signed, () => {
          // unreachable
        });
        expect(result.status).toBe(401);
      }
    );
  });

  it("returns 500 when no webhookSecret is configured", async () => {
    await withSpectrum({}, async (spectrum) => {
      let called = false;
      const signed = signSpectrum(textEnvelope(PLATFORM, "hi"));
      const result = await spectrum.webhook(signed, () => {
        called = true;
      });
      await flush();
      expect(result.status).toBe(500);
      expect(called).toBe(false);
    });
  });

  it("acknowledges (200) an unknown event without calling the handler", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        let called = false;
        const signed = signSpectrum(
          { event: "presence", message: textEnvelope(PLATFORM, "x").message },
          { event: "presence" }
        );
        const result = await spectrum.webhook(signed, () => {
          called = true;
        });
        await flush();
        expect(result.status).toBe(200);
        expect(called).toBe(false);
      }
    );
  });

  it("acknowledges (200) a message for an unregistered platform", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        let called = false;
        const signed = signSpectrum(textEnvelope("not-registered", "hi"));
        const result = await spectrum.webhook(signed, () => {
          called = true;
        });
        await flush();
        expect(result.status).toBe(200);
        expect(called).toBe(false);
      }
    );
  });

  it("returns 200 even when the handler throws (fire-and-forget)", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        const signed = signSpectrum(textEnvelope(PLATFORM, "boom"));
        const result = await spectrum.webhook(signed, () => {
          throw new Error("handler blew up");
        });
        await flush();
        expect(result.status).toBe(200);
      }
    );
  });

  it("delivers identically through a Web Request", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        const received: Message[] = [];
        const { promise: finished, resolve: done } =
          Promise.withResolvers<void>();

        const signed = signSpectrum(textEnvelope(PLATFORM, "via request"));
        const request = new Request("https://example.com/webhook", {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
        });
        const response = await spectrum.webhook(request, (_space, message) => {
          received.push(message);
          done();
        });
        await finished;

        expect(response.status).toBe(200);
        expect(received[0]?.content).toEqual({
          type: "text",
          text: "via request",
        });
      }
    );
  });
});

describe("spectrum.webhook (Standard project webhook)", () => {
  it("recognizes a whsec_-prefixed webhookSecret from the environment", async () => {
    process.env.SPECTRUM_WEBHOOK_SECRET = STANDARD_WEBHOOK_SECRET;
    const spectrum = await Spectrum({
      providers: [makeSlack().config({})],
    });
    try {
      const signed = signStandardDelivery(
        standardPayload({
          challenge: "environment-secret",
          type: "url_verification",
        })
      );
      const result = await spectrum.webhook(signed, () => {
        // URL verification does not emit a message.
      });
      expect(result.status).toBe(200);
    } finally {
      process.env.SPECTRUM_WEBHOOK_SECRET = "";
      await spectrum.stop();
    }
  });

  it("verifies and routes the preserved provider request", async () => {
    const spectrum = await Spectrum({
      providers: [makeSlack().config({})],
      webhookSecret: STANDARD_WEBHOOK_SECRET,
    });
    try {
      const { promise: finished, resolve: done } =
        Promise.withResolvers<void>();
      const received: Message[] = [];
      const signed = signStandardDelivery(
        standardPayload({ type: "message", text: "from standard webhook" })
      );

      const result = await spectrum.webhook(signed, (_space, message) => {
        received.push(message);
        done();
      });
      await finished;

      expect(result.status).toBe(200);
      expect(received[0]?.content).toEqual({
        text: "from standard webhook",
        type: "text",
      });
    } finally {
      await spectrum.stop();
    }
  });

  it("returns the provider's synchronous response", async () => {
    const spectrum = await Spectrum({
      providers: [makeSlack().config({})],
      webhookSecret: STANDARD_WEBHOOK_SECRET,
    });
    try {
      const signed = signStandardDelivery(
        standardPayload({
          challenge: "challenge-response",
          type: "url_verification",
        })
      );
      const result = await spectrum.webhook(signed, () => {
        // URL verification does not emit a message.
      });

      expect(result.status).toBe(200);
      expect(new TextDecoder().decode(result.body)).toBe("challenge-response");
    } finally {
      await spectrum.stop();
    }
  });

  it("rejects a bad Standard signature before provider dispatch", async () => {
    const spectrum = await Spectrum({
      providers: [makeSlack().config({})],
      webhookSecret: STANDARD_WEBHOOK_SECRET,
    });
    try {
      let called = false;
      const signed = signStandardDelivery(
        standardPayload({ type: "message", text: "forged" }),
        Buffer.alloc(32, 0x11)
      );
      const result = await spectrum.webhook(signed, () => {
        called = true;
      });
      await flush();

      expect(result.status).toBe(401);
      expect(called).toBe(false);
    } finally {
      await spectrum.stop();
    }
  });

  it("rejects a payload whose event id differs from webhook-id", async () => {
    const spectrum = await Spectrum({
      providers: [makeSlack().config({})],
      webhookSecret: STANDARD_WEBHOOK_SECRET,
    });
    try {
      const signed = signStandardDelivery(
        standardPayload({ type: "message", text: "mismatch" })
      );
      const body = new TextEncoder().encode(
        new TextDecoder()
          .decode(signed.body)
          .replace("evt-standard-1", "evt-standard-2")
      );
      const timestamp = signed.headers["webhook-timestamp"];
      const base = Buffer.concat([
        Buffer.from(`evt-standard-1.${timestamp}.`, "utf8"),
        Buffer.from(body),
      ]);
      signed.body = body;
      signed.headers["webhook-signature"] = `v1,${createHmac(
        "sha256",
        STANDARD_SECRET_BYTES
      )
        .update(base)
        .digest("base64")}`;

      const result = await spectrum.webhook(signed, () => {
        // unreachable
      });
      expect(result.status).toBe(400);
    } finally {
      await spectrum.stop();
    }
  });

  it("keeps an unprefixed legacy webhookSecret working during migration", async () => {
    const spectrum = await Spectrum({
      providers: [makeSlack().config({})],
      webhookSecret: LEGACY_WEBHOOK_SECRET,
    });
    try {
      const payload = standardPayload({
        type: "message",
        text: "legacy fallback",
      });
      const legacySigned = signSpectrum(payload, {
        secret: LEGACY_WEBHOOK_SECRET,
      });
      const standardSigned = signStandardDelivery(payload);
      const { promise: finished, resolve: done } =
        Promise.withResolvers<void>();
      const received: Message[] = [];

      const result = await spectrum.webhook(
        {
          body: legacySigned.body,
          headers: { ...legacySigned.headers, ...standardSigned.headers },
        },
        (_space, message) => {
          received.push(message);
          done();
        }
      );
      await finished;

      expect(result.status).toBe(200);
      expect(received[0]?.content).toEqual({
        text: "legacy fallback",
        type: "text",
      });
    } finally {
      await spectrum.stop();
    }
  });

  it("returns 500 when neither signing secret is configured", async () => {
    const spectrum = await Spectrum({ providers: [makeSlack().config({})] });
    try {
      const result = await spectrum.webhook(
        signStandardDelivery(
          standardPayload({ type: "message", text: "missing secret" })
        ),
        () => {
          // unreachable
        }
      );
      expect(result.status).toBe(500);
    } finally {
      await spectrum.stop();
    }
  });
});

describe("spectrum.webhook (dispatch / fusor coexistence)", () => {
  it("routes a protobuf body (no signature header) to the fusor path", async () => {
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
      webhookSecret: SPECTRUM_WEBHOOK_SECRET,
    });
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();
    const received: Message[] = [];

    const result = await spectrum.webhook(
      {
        headers: { "content-type": "application/x-protobuf" },
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "message", text: "hello" })
        ),
      },
      (_space, message) => {
        received.push(message);
        done();
      }
    );
    await finished;

    expect(result.status).toBe(200);
    expect(received[0]?.content).toEqual({ type: "text", text: "hello" });

    await spectrum.stop();
  });

  it("routes a SIGNED protobuf body to the fusor path (header doesn't force native)", async () => {
    // Spectrum signs fusor deliveries too, so an `x-spectrum-signature` header on
    // a protobuf body must NOT be misrouted into the native JSON parser.
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [makeSlack().config({})],
      webhookSecret: SPECTRUM_WEBHOOK_SECRET,
    });
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();
    const received: Message[] = [];

    const result = await spectrum.webhook(
      {
        headers: {
          "content-type": "application/x-protobuf",
          "x-spectrum-signature": "v0=deadbeef",
          "x-spectrum-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: encodeEvent(
          "slack",
          JSON.stringify({ type: "message", text: "signed-protobuf" })
        ),
      },
      (_space, message) => {
        received.push(message);
        done();
      }
    );
    await finished;

    expect(result.status).toBe(200);
    expect(received[0]?.content).toEqual({
      type: "text",
      text: "signed-protobuf",
    });

    await spectrum.stop();
  });

  it("throws on a fusor request when no fusor provider is configured", async () => {
    await withSpectrum(
      { webhookSecret: SPECTRUM_WEBHOOK_SECRET },
      async (spectrum) => {
        await expect(
          spectrum.webhook(
            {
              headers: { "content-type": "application/x-protobuf" },
              body: encodeEvent("slack", JSON.stringify({ type: "message" })),
            },
            () => {
              // unreachable
            }
          )
        ).rejects.toThrow(NO_FUSOR_PROVIDER_ERROR);
      }
    );
  });
});
