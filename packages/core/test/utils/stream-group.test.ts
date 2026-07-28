import {
  flush,
  NO_MESSAGE_WAIT_MS,
  withinMs,
} from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
import type { ManagedStream } from "@/utils/stream";
import { createStreamGroup } from "@/utils/stream-group";

// A ManagedStream the test drives by hand. `end()` simulates the source
// finishing on its own (no close call), which the group must treat as a fault;
// `close()` is what the group itself calls, and is counted separately.
const controllable = <T>() => {
  const queued: T[] = [];
  const waiters: {
    reject: (error: unknown) => void;
    resolve: (result: IteratorResult<T, undefined>) => void;
  }[] = [];
  let closeCalls = 0;
  let done = false;
  let nextCalls = 0;
  let pendingFailure: { error: unknown } | undefined;

  const settleDone = (): void => {
    done = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  };

  const close = (): Promise<void> => {
    closeCalls += 1;
    settleDone();
    return Promise.resolve();
  };

  const source: ManagedStream<T> = {
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          nextCalls += 1;
          const value = queued.shift();
          if (value !== undefined) {
            return Promise.resolve({ done: false, value });
          }
          if (pendingFailure) {
            const { error } = pendingFailure;
            pendingFailure = undefined;
            return Promise.reject(error);
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
    closeCalls: () => closeCalls,
    end: settleDone,
    fail(error: unknown): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.reject(error);
      } else {
        pendingFailure = { error };
      }
    },
    nextCalls: () => nextCalls,
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

const takeNext = <T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> =>
  iterator.next() as Promise<IteratorResult<T>>;

describe("createStreamGroup", () => {
  it("delivers values from every attached member", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const group = createStreamGroup<string>({ label: "test" });
    group.add("a", () => a.source);
    group.add("b", () => b.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    b.push("b1");

    const received = [
      (await takeNext(iterator)).value,
      (await takeNext(iterator)).value,
    ];
    expect(received.sort()).toEqual(["a1", "b1"]);

    await group.close();
  });

  it("does not build a member until the group is iterated", async () => {
    const a = controllable<string>();
    const factory = vi.fn(() => a.source);
    const group = createStreamGroup<string>();
    group.add("a", factory);

    await flush();
    expect(factory).not.toHaveBeenCalled();

    const iterator = group[Symbol.asyncIterator]();
    const pending = takeNext(iterator);
    a.push("a1");
    expect((await pending).value).toBe("a1");
    expect(factory).toHaveBeenCalledTimes(1);

    await group.close();
  });

  it("delivers from a member added while the group is running", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    group.add("b", () => b.source);
    b.push("b1");
    expect((await takeNext(iterator)).value).toBe("b1");
    expect(group.keys()).toEqual(["a", "b"]);

    await group.close();
  });

  it("parks with no members instead of ending, then delivers once one is added", async () => {
    const group = createStreamGroup<string>();
    const iterator = group[Symbol.asyncIterator]();
    const pending = takeNext(iterator);

    expect(await withinMs(pending, NO_MESSAGE_WAIT_MS)).toBe("timeout");

    const a = controllable<string>();
    group.add("a", () => a.source);
    a.push("a1");
    expect((await pending).value).toBe("a1");

    await group.close();
  });

  it("closes only the removed member and keeps the rest running", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);
    group.add("b", () => b.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    expect(await group.remove("a")).toBe(true);
    expect(a.closeCalls()).toBe(1);
    expect(b.closeCalls()).toBe(0);
    expect(group.has("a")).toBe(false);
    expect(await group.remove("a")).toBe(false);

    b.push("b1");
    expect((await takeNext(iterator)).value).toBe("b1");

    await group.close();
  });

  it("stays open after its last member is removed", async () => {
    const a = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    await group.remove("a");
    expect(group.keys()).toEqual([]);

    const pending = takeNext(iterator);
    expect(await withinMs(pending, NO_MESSAGE_WAIT_MS)).toBe("timeout");

    const b = controllable<string>();
    group.add("b", () => b.source);
    b.push("b1");
    expect((await pending).value).toBe("b1");

    await group.close();
  });

  it("drops a member that throws without disturbing its siblings", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);
    group.add("b", () => b.source);

    const iterator = group[Symbol.asyncIterator]();
    b.push("b1");
    expect((await takeNext(iterator)).value).toBe("b1");

    a.fail(new Error("boom"));
    await flush();
    expect(group.has("a")).toBe(false);
    expect(group.keys()).toEqual(["b"]);

    b.push("b2");
    expect((await takeNext(iterator)).value).toBe("b2");

    await group.close();
  });

  it("drops a member that ends on its own without ending the group", async () => {
    const a = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    // Pull again first: a worker parked in `emit` unparks only when the
    // consumer pulls, so it cannot observe its source ending until then.
    const pending = takeNext(iterator);
    await flush();
    a.end();
    await flush();
    expect(group.has("a")).toBe(false);

    expect(await withinMs(pending, NO_MESSAGE_WAIT_MS)).toBe("timeout");

    await group.close();
    await pending;
  });

  it("re-attaches a key after its member faulted", async () => {
    const first = controllable<string>();
    const second = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => first.source);

    const iterator = group[Symbol.asyncIterator]();
    first.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    // Pull again so the worker unparks from `emit` and is waiting on its
    // source, which is what `fail` rejects.
    const pending = takeNext(iterator);
    await flush();
    first.fail(new Error("boom"));
    await flush();

    expect(group.add("a", () => second.source)).toBe(true);
    second.push("a2");
    expect((await pending).value).toBe("a2");

    await group.close();
  });

  it("rejects a duplicate key without building a second source", async () => {
    const a = controllable<string>();
    const group = createStreamGroup<string>();
    const factory = vi.fn(() => a.source);
    expect(group.add("a", factory)).toBe(true);
    expect(group.add("a", factory)).toBe(false);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");
    expect(factory).toHaveBeenCalledTimes(1);

    await group.close();
  });

  it("closes every attached source and ends the consumer on close", async () => {
    const a = controllable<string>();
    const b = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);
    group.add("b", () => b.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    await group.close();

    expect(a.closeCalls()).toBeGreaterThanOrEqual(1);
    expect(b.closeCalls()).toBeGreaterThanOrEqual(1);
    expect((await takeNext(iterator)).done).toBe(true);
  });

  it("does not report its members as failed when the group is torn down", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
    const a = controllable<string>();
    const group = createStreamGroup<string>({ label: "teardown" });
    group.add("a", () => a.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    await group.close();
    await flush();

    expect(errors.join("\n")).not.toContain("stream group member");
    spy.mockRestore();
  });

  it("refuses to add after the consumer walks away", async () => {
    const a = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);

    const iterator = group[Symbol.asyncIterator]();
    a.push("a1");
    expect((await takeNext(iterator)).value).toBe("a1");

    // Teardown without close(): the consumer abandoning the iterator stops the
    // stream, so `emit` is dead even though close() was never called.
    await iterator.return?.(undefined);

    const b = controllable<string>();
    const factory = vi.fn(() => b.source);
    expect(group.add("b", factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();

    await group.close();
  });

  it("refuses to add after close and never builds the source", async () => {
    const a = controllable<string>();
    const factory = vi.fn(() => a.source);
    const group = createStreamGroup<string>();

    await group.close();

    expect(group.add("a", factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(group.keys()).toEqual([]);
  });

  it("applies backpressure instead of draining a member eagerly", async () => {
    const a = controllable<string>();
    const group = createStreamGroup<string>();
    group.add("a", () => a.source);

    for (let i = 0; i < 5; i += 1) {
      a.push(`a${i}`);
    }

    const iterator = group[Symbol.asyncIterator]();
    expect((await takeNext(iterator)).value).toBe("a0");
    await flush();

    // An unbounded pump would have drained all five by now.
    expect(a.nextCalls()).toBeLessThan(5);

    await group.close();
  });
});
