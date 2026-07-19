import { afterEach, describe, expect, it, vi } from "vitest";
import { createTokenRenewal } from "@/utils/token-renewal";

describe("createTokenRenewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews at 80% of the TTL and reschedules from the refreshed TTL", async () => {
    vi.useFakeTimers();
    let expiresInSeconds = 10;
    const refresh = vi.fn(async () => {
      expiresInSeconds = 20;
    });
    const renewal = createTokenRenewal({
      expiresInSeconds: () => expiresInSeconds,
      name: "test",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(7999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_999);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    renewal.dispose();
  });

  it("uses a five-second minimum renewal delay", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => Promise.resolve());
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 1,
      name: "test",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    renewal.dispose();
  });

  it("refreshes inside the expiry buffer and coalesces concurrent callers", async () => {
    vi.useFakeTimers();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 60,
      name: "test",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    await renewal.refreshIfNeeded();
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const first = renewal.refreshIfNeeded();
    const second = renewal.refreshIfNeeded();
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(1);
    renewal.dispose();
  });

  it("supports invalidation and unconditional refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => Promise.resolve());
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 3600,
      name: "test",
      refresh,
    });

    renewal.invalidate();
    await renewal.refreshIfNeeded();
    expect(refresh).toHaveBeenCalledTimes(1);

    await renewal.forceRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    renewal.dispose();
  });

  it("coalesces a forced refresh with the scheduled renewal", async () => {
    vi.useFakeTimers();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 10,
      name: "test",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(7999);
    const forced = renewal.forceRefresh();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await forced;
    expect(refresh).toHaveBeenCalledTimes(1);
    renewal.dispose();
  });

  it("retries a failed scheduled refresh after 30 seconds", async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValue(undefined);
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 10,
      name: "test",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(8000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    renewal.dispose();
  });

  it("allows an on-demand refresh to be retried after rejection", async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValue(undefined);
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 60,
      name: "test",
      refresh,
    });

    renewal.invalidate();
    await expect(renewal.refreshIfNeeded()).rejects.toThrow("refresh failed");
    await renewal.refreshIfNeeded();
    expect(refresh).toHaveBeenCalledTimes(2);
    renewal.dispose();
  });

  it("cancels a pending renewal timer", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => Promise.resolve());
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 10,
      name: "test",
      refresh,
    });

    renewal.dispose();
    await vi.advanceTimersByTimeAsync(8000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not rearm after an in-flight refresh settles", async () => {
    vi.useFakeTimers();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const renewal = createTokenRenewal({
      expiresInSeconds: () => 10,
      name: "test",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(8000);
    expect(refresh).toHaveBeenCalledTimes(1);

    renewal.dispose();
    resolveRefresh?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
