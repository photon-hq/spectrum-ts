import { describe, expect, it } from "bun:test";
import { stubCloud } from "@test/support/cloud";
import {
  baseConfig,
  makeManagedProvider,
  makeNativeProvider,
} from "@test/support/platform";
import { withinMs } from "@test/support/timing";
import { Spectrum } from "@/spectrum";

stubCloud();

describe("Spectrum.stop() shutdown", () => {
  it("managed-stream provider: resolves promptly after consuming a message", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-a", { withDestroy: true }).config({}),
      ],
    });
    const it = app.messages[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);

    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("managed-stream provider with no destroyClient: resolves promptly (stream self-closes)", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [makeManagedProvider("managed-nodestroy").config({})],
    });
    const it = app.messages[Symbol.asyncIterator]();
    await it.next();

    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("multiple managed-stream providers: resolves promptly", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-1", { withDestroy: true }).config({}),
        makeManagedProvider("managed-2").config({}),
      ],
    });
    const it = app.messages[Symbol.asyncIterator]();
    await it.next();

    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("no subscription: resolves promptly", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-nosub", { withDestroy: true }).config({}),
      ],
    });
    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("native-generator provider: does not hang — bounded then rescued by destroyClient", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [makeNativeProvider("native").config({})],
    });
    const it = app.messages[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);

    // Can't cancel a parked native generator via return(); the bounded Phase-1
    // wait (STREAM_CLOSE_TIMEOUT_MS) elapses, then destroyClient closes the
    // queue from below. The point is it resolves at all (no infinite hang).
    expect(await withinMs(app.stop(), 9000)).toBe("resolved");
  }, 12_000);
});
