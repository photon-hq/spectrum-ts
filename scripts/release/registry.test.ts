import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registryHas, verifyOnRegistry } from "./registry";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

it("checks the exact package version and succeeds without sleeping", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

  await verifyOnRegistry("@spectrum-ts/core", "12.13.0");

  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    "https://registry.npmjs.org/@spectrum-ts/core/12.13.0",
    { signal: expect.any(AbortSignal) }
  );
  expect(Date.now()).toBe(0);
});

it("waits for an accepted version that becomes visible after three minutes", async () => {
  fetchMock.mockImplementation(
    async () => new Response(null, { status: Date.now() < 180_000 ? 404 : 200 })
  );
  const result = verifyOnRegistry("@spectrum-ts/elysia", "12.13.0").catch(
    (error: unknown) => error
  );

  await vi.advanceTimersByTimeAsync(180_000);

  expect(await result).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(37);
});

it("stops after ten minutes and explains how to resume without a version bump", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
  const settled = vi.fn();
  const result = verifyOnRegistry("@spectrum-ts/express", "12.13.0")
    .catch((error: unknown) => error)
    .then((value) => {
      settled();
      return value;
    });

  await vi.advanceTimersByTimeAsync(599_999);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("@spectrum-ts/express@12.13.0")
  );
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("10 minutes")
  );
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("publish-only")
  );
  expect(fetchMock).toHaveBeenCalledTimes(120);
});

it("retries network and registry errors without treating them as visibility", async () => {
  fetchMock
    .mockRejectedValueOnce(new Error("connection reset"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 200 }));
  const result = verifyOnRegistry("@spectrum-ts/core", "12.13.0");

  await vi.advanceTimersByTimeAsync(10_000);
  await result;

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining("connection reset")
  );
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining("HTTP 503")
  );
});

it("bounds slow probes and the final probe by the remaining deadline", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("probe timed out")), ms);
    return controller.signal;
  });
  fetchMock.mockImplementation(
    (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        );
      })
  );
  // Make the final probe start with only 10 seconds left in the budget.
  fetchMock.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return new Response(null, { status: 404 });
  });
  const result = verifyOnRegistry("@spectrum-ts/core", "12.13.0").catch(
    (error: unknown) => error
  );

  await vi.advanceTimersByTimeAsync(600_000);

  expect(await result).toBeInstanceOf(Error);
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(timeout).toHaveBeenLastCalledWith(10_000);
  expect(Date.now()).toBe(600_000);
});

it("reports missing versions to the idempotent pre-publish check", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

  expect(await registryHas("@spectrum-ts/core", "12.13.0")).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
