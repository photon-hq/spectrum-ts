import { describe, expect, it } from "bun:test";
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
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";

stubCloud();

// The env fallback must not leak in from the host so the missing-secret path is
// exercised deterministically (empty string is falsy → treated as unset).
process.env.SPECTRUM_WEBHOOK_SECRET = "";

const PLATFORM = "im";
const NO_FUSOR_PROVIDER_ERROR = /no fusor provider is configured/;

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
