import { collectUntilIdle } from "@spectrum-ts/test-support/timing";
import { describe, expect, it } from "vitest";
import type { ManagedStream } from "@/utils/stream";

// `collectUntilIdle` ships in @spectrum-ts/test-support, which has no runner of
// its own. It is covered here because it consumes core's ManagedStream contract.

const trackedSource = <T>(
  next: () => Promise<IteratorResult<T, undefined>>
) => {
  let closeCalls = 0;
  const source: ManagedStream<T> = {
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
    [Symbol.asyncIterator]: () => ({ next }),
  };
  return { closeCalls: () => closeCalls, source };
};

describe("collectUntilIdle", () => {
  it("closes the source when iteration rejects, then propagates", async () => {
    const failure = new Error("boom");
    const tracked = trackedSource<string>(() => Promise.reject(failure));

    await expect(collectUntilIdle(tracked.source)).rejects.toThrow("boom");
    expect(tracked.closeCalls()).toBe(1);
  });

  it("collects what arrived and closes once when the source goes idle", async () => {
    const queued = ["a", "b"];
    const tracked = trackedSource<string>(() => {
      const value = queued.shift();
      return value === undefined
        ? new Promise<IteratorResult<string, undefined>>(() => undefined)
        : Promise.resolve({ done: false, value });
    });

    expect(await collectUntilIdle(tracked.source)).toEqual(["a", "b"]);
    expect(tracked.closeCalls()).toBe(1);
  });
});
