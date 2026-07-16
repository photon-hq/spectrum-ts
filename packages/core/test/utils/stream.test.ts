import { describe, expect, it } from "vitest";
import { createAsyncQueue } from "@/utils/stream";

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
