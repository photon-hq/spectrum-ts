import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  encodeEvent,
  type HybridCapture,
  makeHybrid,
} from "@spectrum-ts/test-support/fusor";
import { baseConfig } from "@spectrum-ts/test-support/platform";
import { describe, expect, it, vi } from "vitest";
import { text } from "@/content/text";
import { FusorCore } from "@/fusor/core";
import { FUSOR_BRAND } from "@/fusor/types";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";
import type { Space } from "@/types/space";

stubCloud();

const NO_FUSOR_PROVIDER_ERROR = /no fusor provider is configured/;

const capture = (): HybridCapture => ({
  regularEventProducerCalls: 0,
  regularMessagesCalls: 0,
});

describe("hybrid Fusor providers", () => {
  it("routes a wire name to a differently named provider and gives the handler its regular runtime context", async () => {
    const seen = capture();
    const fixture = makeHybrid(seen, {
      name: "imessage_display",
      route: "imessage-wire",
    });
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [fixture.provider],
    });
    const { promise: delivered, resolve: done } = Promise.withResolvers<void>();
    let received: [Space, Message] | undefined;

    const result = await spectrum.webhook(
      {
        headers: {},
        body: encodeEvent(
          "imessage-wire",
          JSON.stringify({ text: "from-webhook" })
        ),
      },
      (space, message) => {
        received = [space, message];
        done();
      }
    );
    await delivered;

    expect(result.status).toBe(200);
    expect(received?.[0].__platform).toBe("imessage_display");
    expect(received?.[1].platform).toBe("imessage_display");
    expect(received?.[1].id).toBe("fusor-from-webhook");
    expect(seen.createClient).toBe(fixture.client);
    expect(seen.createConfig).toEqual({ token: "hybrid-token" });
    expect(seen.handlerClient).toBe(fixture.client);
    expect(seen.handlerConfig).toEqual({ token: "hybrid-token" });
    expect(seen.handlerProjectConfig).toEqual({
      id: "proj",
      name: "Test Project",
      profile: {},
      slug: "test-project",
    });
    expect(seen.handlerStoreRoundTrip).toBe("from-webhook");
    expect(seen.handlerStore).toBeDefined();

    await spectrum.stop();
    expect(seen.destroyedClient).toBe(fixture.client);
  });

  it("can disable Fusor at initialization and stay credential-free on the regular transport", async () => {
    const seen = capture();
    const fixture = makeHybrid(seen, {
      enabled: false,
      regularMessageId: "regular-only",
    });
    const startSpy = vi
      .spyOn(FusorCore.prototype, "start")
      .mockResolvedValue(undefined);
    try {
      const spectrum = await Spectrum({ providers: [fixture.provider] });
      const iterator = spectrum.messages[Symbol.asyncIterator]();
      const first = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value?.[1].id).toBe("regular-only");
      expect(seen.createClient).toBe(fixture.client);
      expect(seen.handlerClient).toBeUndefined();
      expect(seen.regularMessagesCalls).toBe(1);
      expect(startSpy).not.toHaveBeenCalled();

      if (!first.value) {
        throw new Error("expected a regular hybrid-provider message");
      }
      await first.value[0].send(text("outbound"));
      expect(seen.sendClient).toBe(fixture.client);

      await expect(
        spectrum.webhook(
          { headers: {}, body: new Uint8Array([0]) },
          () => undefined
        )
      ).rejects.toThrow(NO_FUSOR_PROVIDER_ERROR);

      await iterator.return?.();
      await spectrum.stop();
      expect(seen.destroyedClient).toBe(fixture.client);
    } finally {
      startSpy.mockRestore();
    }
  });

  it("destroys the regular client when hybrid initialization fails", async () => {
    const seen = capture();
    const fixture = makeHybrid(seen, {
      createError: new Error("binding failed"),
    });

    await expect(
      Spectrum({
        ...baseConfig,
        providers: [fixture.provider],
      })
    ).rejects.toThrow("binding failed");
    expect(seen.destroyedClient).toBe(fixture.client);
  });

  it("rolls back every earlier provider when a later hybrid binding fails", async () => {
    const firstSeen = capture();
    const failingSeen = capture();
    const first = makeHybrid(firstSeen, {
      name: "initialized_first",
      route: "initialized-first-wire",
    });
    const failing = makeHybrid(failingSeen, {
      createError: new Error("second binding failed"),
      name: "fails_second",
      route: "fails-second-wire",
    });

    await expect(
      Spectrum({
        ...baseConfig,
        providers: [first.provider, failing.provider],
      })
    ).rejects.toThrow("second binding failed");

    expect(firstSeen.destroyedClient).toBe(first.client);
    expect(failingSeen.destroyedClient).toBe(failing.client);
  });

  it("preflights duplicate Fusor routes and rolls back every provider", async () => {
    const firstSeen = capture();
    const secondSeen = capture();
    const first = makeHybrid(firstSeen, {
      name: "duplicate_route_one",
      route: "shared-wire-route",
    });
    const second = makeHybrid(secondSeen, {
      name: "duplicate_route_two",
      route: "shared-wire-route",
    });

    await expect(
      Spectrum({
        ...baseConfig,
        providers: [first.provider, second.provider],
      })
    ).rejects.toThrow(
      'Fusor route "shared-wire-route" is registered by both "duplicate_route_one" and "duplicate_route_two"'
    );

    expect(firstSeen.destroyedClient).toBe(first.client);
    expect(secondSeen.destroyedClient).toBe(second.client);
  });

  it("keeps a stream-only binding off direct webhooks and starts Fusor from provider messages", async () => {
    const seen = capture();
    const fixture = makeHybrid(seen, {
      name: "stream_only_hybrid",
      route: "stream-only-wire",
      streamOnly: true,
    });
    const event = RawInboundEvent.decode(
      encodeEvent("stream-only-wire", JSON.stringify({ text: "authenticated" }))
    );
    const startSpy = vi
      .spyOn(FusorCore.prototype, "start")
      .mockImplementation(async function (this: FusorCore) {
        await this.processEvent(event, undefined, "stream");
      });
    try {
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [fixture.provider],
      });
      const webhookHandler = vi.fn();

      const webhookResult = await spectrum.webhook(
        { headers: {}, body: RawInboundEvent.encode(event).finish() },
        webhookHandler
      );

      expect(webhookResult.status).toBe(400);
      expect(webhookHandler).not.toHaveBeenCalled();
      expect(seen.handlerClient).toBeUndefined();
      expect(startSpy).not.toHaveBeenCalled();

      const providerMessages = fixture.platform(spectrum).messages;
      const iterator = providerMessages[Symbol.asyncIterator]();
      const streamed = await iterator.next();

      expect(streamed.done).toBe(false);
      expect(streamed.value?.[1].id).toBe("fusor-authenticated");
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(seen.handlerClient).toBe(fixture.client);

      await iterator.return?.();
      await spectrum.stop();
    } finally {
      startSpy.mockRestore();
    }
  });

  it("merges Fusor records with the provider's regular messages producer", async () => {
    const seen = capture();
    const fixture = makeHybrid(seen, {
      regularMessageId: "regular-lane",
      route: "hybrid-merge-wire",
    });
    // A hybrid's lifecycle client can be structurally branded by another
    // integration. Runtime source selection must use the binding mode recorded
    // at bootstrap, not re-infer the mode from this client object.
    Object.defineProperty(fixture.client, FUSOR_BRAND, { value: true });
    const event = RawInboundEvent.decode(
      encodeEvent("hybrid-merge-wire", JSON.stringify({ text: "stream-lane" }))
    );
    const startSpy = vi
      .spyOn(FusorCore.prototype, "start")
      .mockImplementation(async function (this: FusorCore) {
        await this.processEvent(event);
      });
    try {
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [fixture.provider],
      });
      const iterator = spectrum.messages[Symbol.asyncIterator]();
      const first = await iterator.next();
      const second = await iterator.next();
      const ids = [first.value?.[1].id, second.value?.[1].id].sort();

      expect(ids).toEqual(["fusor-stream-lane", "regular-lane"]);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(seen.regularMessagesCalls).toBe(1);
      expect(seen.handlerClient).toBe(fixture.client);

      await iterator.return?.();
      await spectrum.stop();
    } finally {
      startSpy.mockRestore();
    }
  });

  it("keeps hybrid custom events on their regular producer", async () => {
    const seen = capture();
    const fixture = makeHybrid(seen, { name: "hybrid_events" });
    const spectrum = await Spectrum({
      ...baseConfig,
      providers: [fixture.provider],
    });
    const iterator = (
      spectrum as unknown as {
        status: AsyncIterable<{ platform: string; state: string }>;
      }
    ).status[Symbol.asyncIterator]();
    const pending = iterator.next();
    fixture.pushEvent("ready");

    await expect(pending).resolves.toEqual({
      done: false,
      value: { platform: "hybrid_events", state: "ready" },
    });
    expect(seen.regularEventProducerCalls).toBe(1);

    await iterator.return?.();
    await spectrum.stop();
  });

  it("bounds Fusor close before tearing down provider clients", async () => {
    vi.useFakeTimers();
    const closeSpy = vi
      .spyOn(FusorCore.prototype, "close")
      .mockImplementation(() => new Promise<void>(() => undefined));
    try {
      const seen = capture();
      const fixture = makeHybrid(seen, {
        name: "blocked_fusor_close",
        route: "blocked-close-wire",
      });
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [fixture.provider],
      });

      const stopping = spectrum.stop();
      const repeatedStop = spectrum.stop();
      const rejected = expect(stopping).rejects.toThrow(
        "fusor core close timed out after 5000ms"
      );

      expect(repeatedStop).toBe(stopping);
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;

      expect(spectrum.stop()).toBe(stopping);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(seen.destroyedClient).toBe(fixture.client);
    } finally {
      closeSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("finishes teardown before surfacing a Fusor close failure", async () => {
    const closeError = new Error("durable checkpoint did not flush");
    const closeSpy = vi
      .spyOn(FusorCore.prototype, "close")
      .mockRejectedValue(closeError);
    try {
      const seen = capture();
      const fixture = makeHybrid(seen, {
        name: "failed_fusor_close",
        route: "failed-close-wire",
      });
      const spectrum = await Spectrum({
        ...baseConfig,
        providers: [fixture.provider],
      });
      const stopping = spectrum.stop();

      expect(spectrum.stop()).toBe(stopping);
      await expect(stopping).rejects.toBe(closeError);

      expect(spectrum.stop()).toBe(stopping);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(seen.destroyedClient).toBe(fixture.client);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
