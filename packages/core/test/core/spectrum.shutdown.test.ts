import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeManagedProvider,
  makeNativeProvider,
} from "@spectrum-ts/test-support/platform";
import { flush, withinMs } from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
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
        makeManagedProvider("managed_a", { withDestroy: true }).config({}),
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
      providers: [makeManagedProvider("managed_nodestroy").config({})],
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
        makeManagedProvider("managed_1", { withDestroy: true }).config({}),
        makeManagedProvider("managed_2").config({}),
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
        makeManagedProvider("managed_nosub", { withDestroy: true }).config({}),
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

// Spectrum is a library: it must never install process signal handlers or call
// process.exit(). The old handler exited ~ms after a signal, killing the host's
// own still-draining shutdown work (Nest hooks, BullMQ jobs).
describe("Spectrum() process signal handling", () => {
  it("registers no SIGINT/SIGTERM listeners", async () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const app = await Spectrum({
      ...baseConfig,
      providers: [makeManagedProvider("managed_signals").config({})],
    });

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);

    await app.stop();
  });

  it("leaves shutdown to the host: its SIGTERM handler drains without process.exit", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const app = await Spectrum({
      ...baseConfig,
      providers: [makeManagedProvider("managed_host_drain").config({})],
    });

    let hostDrained = false;
    const hostHandler = async () => {
      // Stand-in for in-flight work the host must finish before exiting.
      await flush();
      await app.stop();
      hostDrained = true;
    };
    process.once("SIGTERM", hostHandler);
    try {
      // Dispatch through the emitter directly rather than process.kill(), which
      // would also hit any listener the runner itself installed.
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => {
        expect(hostDrained).toBe(true);
      });
    } finally {
      process.off("SIGTERM", hostHandler);
    }

    expect(exit).not.toHaveBeenCalled();
    // Restore only this spy: restoreAllMocks() would also undo stubCloud().
    exit.mockRestore();
  });
});
