import { cloud } from "@spectrum-ts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudClients, disposeCloudAuth } from "@/auth";

type TokenData = Awaited<ReturnType<typeof cloud.issueWhatsappBusinessTokens>>;

const TTL_SECONDS = 900; // 15 min — matches WHATSAPP_BUSINESS_TOKEN_TTL_SECONDS
const RENEW_AT_MS = TTL_SECONDS * 1000 * 0.8; // 720_000 (RENEWAL_RATIO)
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 120_000;

const tokenResponse: TokenData = {
  auth: { PN1: "token" },
  numbers: { PN1: "+15550001111" },
  expiresIn: TTL_SECONDS,
};

describe("whatsapp token renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin jitter to its upper bound (0.5 + 1*0.5 = 1.0) so the backoff delays
    // are the exact exponential values and assertions stay deterministic.
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries a failed renewal after ~RETRY_BASE_MS, not another full TTL", async () => {
    const callTimes: number[] = [];
    const spy = vi
      .spyOn(cloud, "issueWhatsappBusinessTokens")
      .mockImplementation(() => {
        callTimes.push(Date.now());
        // 1st call = initial issue (ok), 2nd = scheduled renewal (fails),
        // 3rd = the retry we are asserting about (ok).
        if (callTimes.length === 2) {
          return Promise.reject(new Error("Internal server error"));
        }
        return Promise.resolve(tokenResponse);
      });

    const clients = await createCloudClients("proj", "secret");
    expect(spy).toHaveBeenCalledTimes(1);

    // Reach the scheduled renewal — it fails.
    await vi.advanceTimersByTimeAsync(RENEW_AT_MS);
    expect(spy).toHaveBeenCalledTimes(2);

    // The bug: the failure path rescheduled a full ~0.8×TTL out, so nothing
    // retried for ~12 min and the token expired. The fix retries at ~30s.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(spy).toHaveBeenCalledTimes(2); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(3); // retry fired

    // The gap is the first backoff step (~30s), not 720s.
    expect((callTimes[2] as number) - (callTimes[1] as number)).toBe(
      RETRY_BASE_MS
    );

    await disposeCloudAuth(clients);
  });

  it("backs off exponentially and caps on repeated failures", async () => {
    const callTimes: number[] = [];
    vi.spyOn(cloud, "issueWhatsappBusinessTokens").mockImplementation(() => {
      callTimes.push(Date.now());
      // Initial issue ok; every renewal after that fails.
      if (callTimes.length === 1) {
        return Promise.resolve(tokenResponse);
      }
      return Promise.reject(new Error("Internal server error"));
    });

    const clients = await createCloudClients("proj", "secret");

    await vi.advanceTimersByTimeAsync(RENEW_AT_MS); // call 2 (fail)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // call 3 (+30s)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // call 4 (+60s)
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS); // call 5 (+120s, capped)
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS); // call 6 (+120s, capped)

    expect(callTimes).toHaveLength(6);
    const gaps = [
      (callTimes[2] as number) - (callTimes[1] as number),
      (callTimes[3] as number) - (callTimes[2] as number),
      (callTimes[4] as number) - (callTimes[3] as number),
      (callTimes[5] as number) - (callTimes[4] as number),
    ];
    expect(gaps).toEqual([30_000, 60_000, 120_000, 120_000]);

    await disposeCloudAuth(clients);
  });

  it("after a successful retry, schedules the next renewal at the TTL ratio", async () => {
    let calls = 0;
    const spy = vi
      .spyOn(cloud, "issueWhatsappBusinessTokens")
      .mockImplementation(() => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(new Error("Internal server error"));
        }
        return Promise.resolve(tokenResponse);
      });

    const clients = await createCloudClients("proj", "secret");

    await vi.advanceTimersByTimeAsync(RENEW_AT_MS); // renewal fails (call 2)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // retry succeeds (call 3)
    expect(spy).toHaveBeenCalledTimes(3);

    // Next renewal must be a full ratio-of-TTL away, NOT another backoff step.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(spy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(RENEW_AT_MS);
    expect(spy).toHaveBeenCalledTimes(4);

    await disposeCloudAuth(clients);
  });
});
