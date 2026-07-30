import {
  flush,
  NO_MESSAGE_WAIT_MS,
  settleSoon,
  withinMs,
} from "@spectrum-ts/test-support/timing";
import { describe, expect, it } from "vitest";
import {
  createAsyncQueue,
  type ManagedStream,
  mergeStreams,
  stream,
} from "@/utils/stream";

// Characterization tests for the semantics that make `mergeStreams` unsuitable
// for a source set that changes at runtime. `createStreamGroup` deliberately
// diverges on all three; see stream-group.test.ts for the opposite assertions.

const controllable = <T>() => {
  const queued: T[] = [];
  const waiters: {
    reject: (error: unknown) => void;
    resolve: (result: IteratorResult<T, undefined>) => void;
  }[] = [];
  let done = false;

  const close = (): Promise<void> => {
    done = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
    return Promise.resolve();
  };

  const source: ManagedStream<T> = {
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          const value = queued.shift();
          if (value !== undefined) {
            return Promise.resolve({ done: false, value });
          }
          if (done) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve, reject) => {
            waiters.push({ reject, resolve });
          });
        },
        return(): Promise<IteratorResult<T, undefined>> {
          return close().then(() => ({ done: true, value: undefined }));
        },
      };
    },
  };

  return {
    end: close,
    fail(error: unknown): void {
      const waiter = waiters.shift();
      waiter?.reject(error);
    },
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value });
      } else {
        queued.push(value);
      }
    },
    source,
  };
};

describe("stream", () => {
  it("runs setup lazily and cleans up on close", async () => {
    let started = false;
    let cleaned = false;
    let emitValue: ((value: string) => Promise<void>) | undefined;
    const managed = stream<string>((emit) => {
      started = true;
      emitValue = emit;
      return () => {
        cleaned = true;
      };
    });

    expect(started).toBe(false);

    const iterator = managed[Symbol.asyncIterator]();
    const pending = iterator.next();
    await flush();
    expect(started).toBe(true);

    const delivered = emitValue?.("first");
    expect((await pending).value).toBe("first");

    await managed.close();
    expect(cleaned).toBe(true);
    await settleSoon(delivered);
  });
});

describe("mergeStreams", () => {
  it("ends immediately when given no sources", async () => {
    const merged = mergeStreams<string>([]);
    const iterator = merged[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(true);
  });

  it("ends once every source has ended", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const merged = mergeStreams([a.source, b.source]);
    const iterator = merged[Symbol.asyncIterator]();

    a.push("a1");
    expect((await iterator.next()).value).toBe("a1");

    a.end();
    const pending = iterator.next();
    // One source ending is not enough — the merge represents all of them.
    expect(await withinMs(pending, NO_MESSAGE_WAIT_MS)).toBe("timeout");

    b.end();
    expect((await pending).done).toBe(true);
  });

  it("ends the whole merge when a single source fails", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const merged = mergeStreams([a.source, b.source]);
    const iterator = merged[Symbol.asyncIterator]();

    b.push("b1");
    expect((await iterator.next()).value).toBe("b1");

    const failure = new Error("boom");
    a.fail(failure);

    await expect(iterator.next()).rejects.toThrow("boom");
  });
});

describe("async queue", () => {
  it("surfaces a terminal failure to a parked and future reader", async () => {
    const queue = createAsyncQueue<number>();
    const iterator = queue.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    const failure = new Error("terminal transport failure");

    queue.fail(failure);

    await expect(pending).rejects.toBe(failure);
    await expect(iterator.next()).rejects.toBe(failure);
  });

  it("drains buffered values before surfacing a terminal failure", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.fail(new Error("failed after enqueue"));
    const iterator = queue.iterable[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(iterator.next()).rejects.toThrow("failed after enqueue");
  });
});
