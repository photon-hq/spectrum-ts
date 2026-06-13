import { describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import { stubCloud } from "@test/support/cloud";
import { baseConfig, makeManagedProvider } from "@test/support/platform";
import { flush } from "@test/support/timing";
import {
  type SignedSpectrumWebhook,
  SPECTRUM_WEBHOOK_SECRET,
  signSpectrum,
  textEnvelope,
} from "@test/support/webhook";
import express from "express";
import { spectrum } from "@/express";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";

stubCloud();

// Don't let a host env secret leak into the wrong-secret case.
process.env.SPECTRUM_WEBHOOK_SECRET = "";

const PLATFORM = "im";

const makeApp = (overrides: Record<string, unknown> = {}) =>
  Spectrum({
    ...baseConfig,
    providers: [makeManagedProvider(PLATFORM).config({})],
    webhookSecret: SPECTRUM_WEBHOOK_SECRET,
    ...overrides,
  });

/** Boot the express app on an ephemeral port; returns the base URL + a closer. */
const listen = async (server: express.Express) => {
  const http = server.listen(0);
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
};

const post = (url: string, signed: SignedSpectrumWebhook) =>
  fetch(url, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });

describe("spectrum (express plugin)", () => {
  it("verifies and delivers a signed webhook (raw body survives express.raw)", async () => {
    const app = await makeApp();
    const received: Message[] = [];
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const server = express().use(
      spectrum({
        app,
        onMessage: (_space, message) => {
          received.push(message);
          done();
        },
      })
    );
    const { url, close } = await listen(server);

    try {
      const signed = signSpectrum(textEnvelope(PLATFORM, "hello there"));
      const response = await post(`${url}/spectrum/webhook`, signed);
      await finished;

      // A valid signature only verifies if the exact wire bytes reached the SDK
      // — so a 200 here proves express.raw handed over the untouched body.
      expect(response.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toEqual({
        type: "text",
        text: "hello there",
      });
    } finally {
      await close();
      await app.stop();
    }
  });

  it("rejects a bad signature with 401 and never calls onMessage", async () => {
    const app = await makeApp();
    let called = false;

    const server = express().use(
      spectrum({
        app,
        onMessage: () => {
          called = true;
        },
      })
    );
    const { url, close } = await listen(server);

    try {
      const signed = signSpectrum(textEnvelope(PLATFORM, "hi"), {
        secret: "the-wrong-secret",
      });
      const response = await post(`${url}/spectrum/webhook`, signed);
      await flush();

      expect(response.status).toBe(401);
      expect(called).toBe(false);
    } finally {
      await close();
      await app.stop();
    }
  });

  it("honors a custom path", async () => {
    const app = await makeApp();
    const { promise: finished, resolve: done } = Promise.withResolvers<void>();

    const server = express().use(
      spectrum({
        app,
        path: "/hooks/spectrum",
        onMessage: () => done(),
      })
    );
    const { url, close } = await listen(server);

    try {
      const signed = signSpectrum(textEnvelope(PLATFORM, "custom path"));
      const response = await post(`${url}/hooks/spectrum`, signed);
      await finished;

      expect(response.status).toBe(200);
    } finally {
      await close();
      await app.stop();
    }
  });
});
