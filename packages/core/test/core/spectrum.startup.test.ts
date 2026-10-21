import { setupOtel } from "@photon-ai/otel";
import { makeManagedProvider } from "@spectrum-ts/test-support/platform";
import { flush } from "@spectrum-ts/test-support/timing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod";
import { Spectrum } from "@/spectrum";
import { cloud } from "@/utils/cloud";
import { SpectrumStartupCleanupError } from "@/utils/errors";

const telemetry = vi.hoisted(() => ({ shutdown: vi.fn() }));

vi.mock("@photon-ai/otel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@photon-ai/otel")>()),
  setupOtel: vi.fn(() => telemetry),
}));

const provider = (name: string) => {
  const config = makeManagedProvider(name, { withDestroy: true }).config({});
  return {
    config,
    create: vi.spyOn(config.__definition.lifecycle, "createClient"),
    destroy: vi.spyOn(config.__definition.lifecycle, "destroyClient"),
  };
};

beforeEach(() => {
  vi.mocked(setupOtel).mockClear();
  telemetry.shutdown.mockReset().mockResolvedValue(undefined);
  vi.spyOn(cloud, "getProject").mockResolvedValue({
    id: "project",
    name: "Test project",
    profile: {},
    slug: "test-project",
  });
  vi.spyOn(cloud, "getPlatforms").mockResolvedValue({
    imessage: { enabled: false },
    slack: { enabled: false },
    whatsapp_business: { enabled: false },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Spectrum startup cancellation and rollback", () => {
  it("rejects a pre-aborted start before project lookup or provider creation", async () => {
    const first = provider("first");
    const reason = new Error("removed");
    await expect(
      Spectrum({
        projectId: "project",
        projectSecret: "test-secret",
        providers: [first.config],
        signal: AbortSignal.abort(reason),
        telemetry: true,
      })
    ).rejects.toBe(reason);
    expect(cloud.getProject).not.toHaveBeenCalled();
    expect(first.create).not.toHaveBeenCalled();
    expect(setupOtel).not.toHaveBeenCalled();
  });

  it("waits for telemetry cleanup when project lookup fails", async () => {
    const first = provider("first");
    const failure = new Error("project lookup failed");
    const cleanup = Promise.withResolvers<void>();
    vi.mocked(cloud.getProject).mockRejectedValue(failure);
    telemetry.shutdown.mockReturnValue(cleanup.promise);
    let settled = false;
    const outcome = Spectrum({
      projectId: "project",
      projectSecret: "test-secret",
      providers: [first.config],
      telemetry: true,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(telemetry.shutdown).toHaveBeenCalledTimes(1));
    expect(first.create).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await outcome).toBe(failure);
  });

  it("reports telemetry cleanup failure without hiding the startup error", async () => {
    const first = provider("first");
    const failing = provider("failing");
    const failure = new Error("provider startup failed");
    const cleanupFailure = new Error("telemetry shutdown failed");
    failing.create.mockRejectedValue(failure);
    telemetry.shutdown.mockRejectedValue(cleanupFailure);
    await expect(
      Spectrum({ providers: [first.config, failing.config], telemetry: true })
    ).rejects.toMatchObject({
      name: "SpectrumStartupCleanupError",
      cause: failure,
      errors: [cleanupFailure],
    });
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(telemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it("destroys every completed provider when a later provider fails", async () => {
    const first = provider("first");
    const second = provider("second");
    const failing = provider("failing");
    const unstarted = provider("unstarted");
    const failure = new Error("token request failed");
    failing.create.mockRejectedValue(failure);
    await expect(
      Spectrum({
        providers: [
          first.config,
          second.config,
          failing.config,
          unstarted.config,
        ],
      })
    ).rejects.toBe(failure);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(failing.destroy).not.toHaveBeenCalled();
    expect(unstarted.create).not.toHaveBeenCalled();
  });

  it("also rolls back when a later provider config fails validation", async () => {
    const first = provider("first");
    const invalid = provider("invalid");
    invalid.config.__definition.config = z.object({ required: z.string() });
    await expect(
      Spectrum({ providers: [first.config, invalid.config] })
    ).rejects.toThrow();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(invalid.create).not.toHaveBeenCalled();
  });

  it("waits for rollback before rejecting initialization", async () => {
    const first = provider("first");
    const failing = provider("failing");
    const failure = new Error("startup failed");
    const cleanup = Promise.withResolvers<void>();
    first.destroy.mockReturnValue(cleanup.promise);
    failing.create.mockRejectedValue(failure);
    let settled = false;
    const outcome = Spectrum({
      providers: [first.config, failing.config],
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(first.destroy).toHaveBeenCalled());
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await outcome).toBe(failure);
  });

  it("keeps waiting for an uncooperative factory, then destroys its late client", async () => {
    const first = provider("first");
    const late = provider("late");
    const unstarted = provider("unstarted");
    const controller = new AbortController();
    const pending = Promise.withResolvers<object>();
    late.create.mockReturnValue(pending.promise);
    let settled = false;
    const outcome = Spectrum({
      providers: [first.config, late.config, unstarted.config],
      signal: controller.signal,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(late.create).toHaveBeenCalled());
    expect(late.create.mock.calls[0]?.[0].signal).toBe(controller.signal);
    const reason = new DOMException("deadline", "TimeoutError");
    controller.abort(reason);
    await flush();
    expect(settled).toBe(false);
    const client = {};
    pending.resolve(client);
    expect(await outcome).toBe(reason);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(late.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ client })
    );
    expect(unstarted.create).not.toHaveBeenCalled();
  });

  it("does not stop a successful instance when its startup signal expires", async () => {
    const first = provider("first");
    const controller = new AbortController();
    const app = await Spectrum({
      providers: [first.config],
      signal: controller.signal,
    });
    controller.abort();
    expect(first.destroy).not.toHaveBeenCalled();
    await app.stop();
    expect(first.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])("normalizes provider cleanup errors and retains the root cause (rollback also fails: %s)", async (alsoFails) => {
    const first = provider("first");
    const failing = provider("failing");
    const reason = new DOMException("deadline", "TimeoutError");
    const providerFailure = new Error("provider cleanup failed");
    const rollbackFailure = new Error("earlier provider cleanup failed");
    if (alsoFails) {
      first.destroy.mockRejectedValue(rollbackFailure);
    }
    failing.create.mockRejectedValue(
      Object.assign(
        new AggregateError(
          [providerFailure],
          "Spectrum startup cleanup failed",
          { cause: reason }
        ),
        { name: "SpectrumStartupCleanupError" }
      )
    );
    const error = await Spectrum({
      providers: [first.config, failing.config],
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SpectrumStartupCleanupError);
    expect(error).toMatchObject({
      cause: reason,
      errors: alsoFails
        ? [providerFailure, rollbackFailure]
        : [providerFailure],
    });
  });

  it("reports cleanup failure distinctly and waits for the other cleanups", async () => {
    const first = provider("first");
    const second = provider("second");
    const failing = provider("failing");
    const failure = new Error("startup failed");
    const cleanupFailure = new Error("close failed");
    const cleanup = Promise.withResolvers<void>();
    first.destroy.mockRejectedValue(cleanupFailure);
    second.destroy.mockReturnValue(cleanup.promise);
    failing.create.mockRejectedValue(failure);
    let settled = false;
    const outcome = Spectrum({
      providers: [first.config, second.config, failing.config],
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(second.destroy).toHaveBeenCalled());
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await outcome).toMatchObject({
      name: "SpectrumStartupCleanupError",
      cause: failure,
      errors: [cleanupFailure],
    });
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });
});
