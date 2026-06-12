import { describe, expect, it } from "bun:test";
import { flush, withinMs } from "@spectrum-ts/test-support/timing";
import {
  type CloseableAsyncIterable,
  PERSISTENT_FAILURE_ERROR_THRESHOLD,
  type ResumableStreamItem,
  resumableOrderedStream,
} from "@/utils/resumable-stream";

type Item = ResumableStreamItem<string>;

class FakeCursorError extends Error {
  constructor() {
    super("unknown cursor");
    this.name = "FakeCursorError";
  }
}

const isFakeCursorError = (error: unknown): boolean =>
  error instanceof FakeCursorError;

const item = (id: string, value: string): Item => ({
  cursor: id,
  id,
  values: [value],
});

const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

// Scripted live session: yields `events`, then throws, ends naturally, or
// parks until close() (mirroring a gRPC stream that settles when aborted).
const liveSession = (
  events: Item[],
  outcome: "throw" | "end" | "pending",
  error?: () => unknown
): CloseableAsyncIterable<Item> => {
  const parked = gate();
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
      if (outcome === "throw") {
        throw error?.() ?? new Error("live drop");
      }
      if (outcome === "pending") {
        await parked.opened;
      }
    },
    close: () => parked.open(),
  };
};

const emptyCatchUp = async function* (): AsyncGenerator<Item> {
  // no missed events
};

// A source whose first pull fails (optionally after `ready` resolves) — a
// plain iterator object because a yield-less generator trips lint useYield.
const failingSource = (
  makeError: () => unknown,
  ready: Promise<void> = Promise.resolve()
): CloseableAsyncIterable<Item> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => {
      await ready;
      throw makeError();
    },
  }),
});

interface FixtureConfig {
  bufferLimit?: number;
  fetchMissed?: (call: number, cursor: string) => AsyncIterable<Item>;
  initialRetryDelayMs?: number;
  isCursorRejectedError?: (error: unknown) => boolean;
  jitter?: (delayMs: number) => number;
  live: (
    call: number,
    cursor: string | undefined
  ) => CloseableAsyncIterable<Item>;
  maxRetryDelayMs?: number;
  processMissed?: (event: Item) => Promise<Item>;
}

const buildStream = (config: FixtureConfig) => {
  const delays: number[] = [];
  const liveCalls: (string | undefined)[] = [];
  const fetchCalls: string[] = [];
  const received: string[] = [];

  const source = resumableOrderedStream<Item, Item, string>({
    bufferLimit: config.bufferLimit,
    fetchMissed: (cursor) => {
      fetchCalls.push(cursor);
      return (config.fetchMissed ?? (() => emptyCatchUp()))(
        fetchCalls.length,
        cursor
      );
    },
    initialRetryDelayMs: config.initialRetryDelayMs ?? 1,
    isCursorRejectedError: config.isCursorRejectedError,
    jitter:
      config.jitter ??
      ((delayMs) => {
        delays.push(delayMs);
        return 0;
      }),
    maxRetryDelayMs: config.maxRetryDelayMs ?? 8,
    processLive: (event) => Promise.resolve(event),
    processMissed: config.processMissed ?? ((event) => Promise.resolve(event)),
    subscribeLive: (cursor) => {
      liveCalls.push(cursor);
      return config.live(liveCalls.length, cursor);
    },
  });

  const ended = (async () => {
    try {
      for await (const value of source) {
        received.push(value);
      }
      return "done" as const;
    } catch {
      return "error" as const;
    }
  })();

  return {
    close: () => source.close(),
    delays,
    ended,
    fetchCalls,
    liveCalls,
    received,
  };
};

// Yields through the timer queue (not just the check phase) so the stream's
// jittered setTimeout backoff sleeps get a chance to fire between turns.
const waitUntil = async (condition: () => boolean): Promise<void> => {
  const maxTurns = 500;
  for (let turn = 0; turn < maxTurns && !condition(); turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) {
    throw new Error("waitUntil: condition not met");
  }
};

describe("resumableOrderedStream", () => {
  it("reconnects through catch-up after a transient live error without duplicates", async () => {
    const fx = buildStream({
      fetchMissed: () =>
        (async function* (): AsyncGenerator<Item> {
          yield item("2", "v2"); // replay of the already-delivered event
          yield item("3", "v3");
        })(),
      live: (call) =>
        call === 1
          ? liveSession([item("1", "v1"), item("2", "v2")], "throw")
          : liveSession([item("4", "v4")], "pending"),
    });

    await waitUntil(() => fx.received.includes("v4"));
    expect(fx.received).toEqual(["v1", "v2", "v3", "v4"]);
    expect(fx.liveCalls).toEqual([undefined, "2"]);
    expect(fx.fetchCalls).toEqual(["2"]);
    expect(fx.delays).toEqual([1]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("drops the cursor and resumes live when catch-up rejects it", async () => {
    const fx = buildStream({
      fetchMissed: () => failingSource(() => new FakeCursorError()),
      isCursorRejectedError: isFakeCursorError,
      live: (call) => {
        if (call === 1) {
          return liveSession([item("1", "v1"), item("2", "v2")], "throw");
        }
        if (call === 2) {
          return liveSession([], "pending");
        }
        // Reuses a previously delivered id: must be re-delivered because the
        // dedup state is cleared along with the rejected cursor.
        return liveSession(
          [{ cursor: "9", id: "2", values: ["v2-again"] }],
          "pending"
        );
      },
    });

    await waitUntil(() => fx.received.includes("v2-again"));
    expect(fx.received).toEqual(["v1", "v2", "v2-again"]);
    expect(fx.liveCalls).toEqual([undefined, "2", undefined]);
    expect(fx.fetchCalls).toEqual(["2"]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("keeps the cursor when a live error matches the cursor-rejection predicate", async () => {
    const fx = buildStream({
      isCursorRejectedError: isFakeCursorError,
      live: (call) =>
        call === 1
          ? liveSession([item("1", "v1")], "throw", () => new FakeCursorError())
          : liveSession([], "pending"),
    });

    await waitUntil(() => fx.fetchCalls.length === 1);
    expect(fx.fetchCalls).toEqual(["1"]);
    expect(fx.liveCalls).toEqual([undefined, "1"]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("keeps the cursor when the catch-up live pump fails with a predicate-matching error", async () => {
    const gateLive = gate();
    const gateFetch = gate();
    const fx = buildStream({
      fetchMissed: (call) =>
        call === 1
          ? (async function* (): AsyncGenerator<Item> {
              yield item("2", "v2");
              await gateFetch.opened;
              yield item("3", "v3");
            })()
          : emptyCatchUp(),
      isCursorRejectedError: isFakeCursorError,
      live: (call) => {
        if (call === 1) {
          return liveSession([item("1", "v1")], "throw");
        }
        if (call === 2) {
          return failingSource(() => new FakeCursorError(), gateLive.opened);
        }
        return liveSession([], "pending");
      },
    });

    await waitUntil(() => fx.received.includes("v2"));
    gateLive.open();
    await flush();
    gateFetch.open();
    await waitUntil(() => fx.liveCalls.length === 3);
    // The live error surfaced mid-replay must not clear the cursor, which has
    // already advanced past the replayed event.
    expect(fx.liveCalls).toEqual([undefined, "1", "2"]);
    expect(fx.fetchCalls).toEqual(["1", "2"]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("does not treat processMissed failures as cursor rejection", async () => {
    let processCalls = 0;
    const fx = buildStream({
      fetchMissed: () =>
        (async function* (): AsyncGenerator<Item> {
          yield item("2", "v2");
        })(),
      isCursorRejectedError: isFakeCursorError,
      live: (call) =>
        call === 1
          ? liveSession([item("1", "v1")], "throw")
          : liveSession([], "pending"),
      processMissed: (event) => {
        processCalls += 1;
        if (processCalls === 1) {
          return Promise.reject(new FakeCursorError());
        }
        return Promise.resolve(event);
      },
    });

    await waitUntil(() => fx.received.includes("v2"));
    expect(fx.fetchCalls).toEqual(["1", "1"]);
    expect(fx.received).toEqual(["v1", "v2"]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("never ends the stream on persistent errors", async () => {
    let attempts = 0;
    const fx = buildStream({
      live: () => {
        attempts += 1;
        return failingSource(() => new Error("unauthenticated"));
      },
    });

    await waitUntil(() => attempts >= PERSISTENT_FAILURE_ERROR_THRESHOLD + 2);
    expect(await withinMs(fx.ended, 20)).toBe("timeout");
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("doubles the delay to the cap and resets after recovery", async () => {
    const fx = buildStream({
      live: (call) => {
        if (call <= 5) {
          return liveSession([], "throw");
        }
        if (call === 6) {
          return liveSession([item("1", "v1")], "throw");
        }
        return liveSession([], "pending");
      },
    });

    await waitUntil(() => fx.delays.length === 6);
    expect(fx.delays).toEqual([1, 2, 4, 8, 8, 1]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("close() interrupts a long backoff sleep promptly", async () => {
    const fx = buildStream({
      initialRetryDelayMs: 60_000,
      jitter: (delayMs) => delayMs,
      live: () => liveSession([], "throw"),
      maxRetryDelayMs: 60_000,
    });

    await waitUntil(() => fx.liveCalls.length === 1);
    await flush();
    expect(await withinMs(fx.close(), 200)).toBe("resolved");
    expect(await fx.ended).toBe("done");
  });

  it("close() during catch-up replay ends cleanly", async () => {
    const fx = buildStream({
      fetchMissed: () =>
        (async function* (): AsyncGenerator<Item> {
          let next = 2;
          for (;;) {
            yield item(String(next), `v${next}`);
            next += 1;
            await flush();
          }
        })(),
      live: (call) =>
        call === 1
          ? liveSession([item("1", "v1")], "throw")
          : liveSession([], "pending"),
    });

    await waitUntil(() => fx.received.length >= 5);
    expect(await withinMs(fx.close(), 200)).toBe("resolved");
    expect(await fx.ended).toBe("done");
  });

  it("recovers from live-buffer overflow during catch-up", async () => {
    const gateFetch = gate();
    const fx = buildStream({
      bufferLimit: 1,
      fetchMissed: (call) =>
        call === 1
          ? (async function* (): AsyncGenerator<Item> {
              await gateFetch.opened;
              yield item("2", "v2");
            })()
          : emptyCatchUp(),
      live: (call) => {
        if (call === 1) {
          return liveSession([item("1", "v1")], "throw");
        }
        if (call === 2) {
          return liveSession([item("2", "v2"), item("3", "v3")], "pending");
        }
        return liveSession([item("4", "v4")], "pending");
      },
    });

    await waitUntil(() => fx.liveCalls.length === 2);
    await flush();
    gateFetch.open();
    await waitUntil(() => fx.received.includes("v4"));
    expect(fx.liveCalls).toEqual([undefined, "1", "1"]);
    expect(fx.fetchCalls).toEqual(["1", "1"]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });

  it("reconnects with catch-up after the live stream ends naturally", async () => {
    const fx = buildStream({
      fetchMissed: () =>
        (async function* (): AsyncGenerator<Item> {
          yield item("2", "v2");
        })(),
      live: (call) =>
        call === 1
          ? liveSession([item("1", "v1")], "end")
          : liveSession([], "pending"),
    });

    await waitUntil(() => fx.received.includes("v2"));
    expect(fx.liveCalls).toEqual([undefined, "1"]);
    expect(fx.fetchCalls).toEqual(["1"]);
    expect(fx.delays).toEqual([1]);
    await fx.close();
    expect(await fx.ended).toBe("done");
  });
});
