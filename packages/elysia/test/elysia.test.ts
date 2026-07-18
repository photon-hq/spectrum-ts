import { type Message, Spectrum } from "@spectrum-ts/core";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
} from "@spectrum-ts/test-support/platform";
import { flush } from "@spectrum-ts/test-support/timing";
import {
  type SignedSpectrumWebhook,
  SPECTRUM_WEBHOOK_SECRET,
  signSpectrum,
  textEnvelope,
} from "@spectrum-ts/test-support/webhook";
import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";
import { spectrum } from "@/index";

stubCloud();

// Don't let a host env secret leak into the wrong-secret case.
process.env.SPECTRUM_WEBHOOK_SECRET = "";

const PLATFORM = "im";
const DEFAULT_URL = "https://example.com/spectrum/webhook";

const makeApp = (overrides: Record<string, unknown> = {}) =>
  Spectrum({
    ...baseConfig,
    providers: [makeManagedProvider(PLATFORM).config({})],
    webhookSecret: SPECTRUM_WEBHOOK_SECRET,
    ...overrides,
  });

const post = (signed: SignedSpectrumWebhook, url = DEFAULT_URL) =>
  new Request(url, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });

describe("spectrum (elysia plugin)", () => {
  it("verifies and delivers a signed webhook (raw body survives Elysia parsing)", async () => {
    const app = await makeApp();
    try {
      const received: Message[] = [];
      const { promise: finished, resolve: done } =
        Promise.withResolvers<void>();

      const elysia = new Elysia().use(
        spectrum({
          app,
          onMessage: (_space, message) => {
            received.push(message);
            done();
          },
        })
      );

      const signed = signSpectrum(textEnvelope(PLATFORM, "hello there"));
      const response = await elysia.handle(post(signed));
      await finished;

      // A valid signature only verifies if the exact wire bytes reached the SDK
      // — so a 200 here proves Elysia never consumed or re-encoded the body.
      expect(response.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toEqual({
        type: "text",
        text: "hello there",
      });
    } finally {
      await app.stop();
    }
  });

  it("rejects a bad signature with 401 and never calls onMessage", async () => {
    const app = await makeApp();
    try {
      let called = false;
      const elysia = new Elysia().use(
        spectrum({
          app,
          onMessage: () => {
            called = true;
          },
        })
      );

      const signed = signSpectrum(textEnvelope(PLATFORM, "hi"), {
        secret: "the-wrong-secret",
      });
      const response = await elysia.handle(post(signed));
      await flush();

      expect(response.status).toBe(401);
      expect(called).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it("honors a custom path", async () => {
    const app = await makeApp();
    try {
      const { promise: finished, resolve: done } =
        Promise.withResolvers<void>();
      const elysia = new Elysia().use(
        spectrum({
          app,
          path: "/hooks/spectrum",
          onMessage: () => done(),
        })
      );

      const signed = signSpectrum(textEnvelope(PLATFORM, "custom path"));
      const response = await elysia.handle(
        post(signed, "https://example.com/hooks/spectrum")
      );
      await finished;

      expect(response.status).toBe(200);
    } finally {
      await app.stop();
    }
  });
});
