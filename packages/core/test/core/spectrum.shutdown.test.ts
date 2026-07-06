import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
  makeNativeProvider,
} from "@spectrum-ts/test-support/platform";
import { withinMs } from "@spectrum-ts/test-support/timing";
import { describe, expect, it } from "vitest";
import { Spectrum } from "@/spectrum";

stubCloud();

// A managed-stream provider tears down promptly; a generous upper bound that
// still fails loudly on a regression to the old deadlock.
const PROMPT_SHUTDOWN_TIMEOUT_MS = 1500;
// A native generator can't be cancelled, so stop() waits out the bounded
// Phase-1 window before destroyClient rescues it — allow for that.
const NATIVE_SHUTDOWN_TIMEOUT_MS = 9000;
// Per-test ceiling for the native case, comfortably above its shutdown wait.
const NATIVE_TEST_TIMEOUT_MS = 12_000;

describe("Spectrum.stop() shutdown", () => {
  it("managed-stream provider: resolves promptly after consuming a message", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-a", { withDestroy: true }).config({}),
      ],
    });
    const messagesIterator = app.messages[Symbol.asyncIterator]();
    const first = await messagesIterator.next();
    expect(first.done).toBe(false);

    expect(await withinMs(app.stop(), PROMPT_SHUTDOWN_TIMEOUT_MS)).toBe(
      "resolved"
    );
  });

  it("managed-stream provider with no destroyClient: resolves promptly (stream self-closes)", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [makeManagedProvider("managed-nodestroy").config({})],
    });
    const messagesIterator = app.messages[Symbol.asyncIterator]();
    await messagesIterator.next();

    expect(await withinMs(app.stop(), PROMPT_SHUTDOWN_TIMEOUT_MS)).toBe(
      "resolved"
    );
  });

  it("multiple managed-stream providers: resolves promptly", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-1", { withDestroy: true }).config({}),
        makeManagedProvider("managed-2").config({}),
      ],
    });
    const messagesIterator = app.messages[Symbol.asyncIterator]();
    await messagesIterator.next();

    expect(await withinMs(app.stop(), PROMPT_SHUTDOWN_TIMEOUT_MS)).toBe(
      "resolved"
    );
  });

  it("no subscription: resolves promptly", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-nosub", { withDestroy: true }).config({}),
      ],
    });
    expect(await withinMs(app.stop(), PROMPT_SHUTDOWN_TIMEOUT_MS)).toBe(
      "resolved"
    );
  });

  it(
    "native-generator provider: does not hang — bounded then rescued by destroyClient",
    async () => {
      const app = await Spectrum({
        ...baseConfig,
        providers: [makeNativeProvider("native").config({})],
      });
      const messagesIterator = app.messages[Symbol.asyncIterator]();
      const first = await messagesIterator.next();
      expect(first.done).toBe(false);

      // Can't cancel a parked native generator via return(); the bounded Phase-1
      // wait (STREAM_CLOSE_TIMEOUT_MS) elapses, then destroyClient closes the
      // queue from below. The point is it resolves at all (no infinite hang).
      expect(await withinMs(app.stop(), NATIVE_SHUTDOWN_TIMEOUT_MS)).toBe(
        "resolved"
      );
    },
    NATIVE_TEST_TIMEOUT_MS
  );
});
