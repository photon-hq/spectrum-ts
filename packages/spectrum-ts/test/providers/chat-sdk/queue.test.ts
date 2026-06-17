import { describe, expect, it } from "bun:test";
import { makeEventQueue } from "@/providers/chat-sdk/queue";

describe("makeEventQueue", () => {
  it("buffers values pushed before a consumer pulls them, in order", async () => {
    const queue = makeEventQueue<number>();
    queue.push(1);
    queue.push(2);
    const it = queue.iter[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
  });

  it("delivers a value to a consumer already waiting on next()", async () => {
    const queue = makeEventQueue<string>();
    const it = queue.iter[Symbol.asyncIterator]();
    const pending = it.next();
    queue.push("a");
    expect(await pending).toEqual({ value: "a", done: false });
  });

  it("ends a waiting consumer when closed", async () => {
    const queue = makeEventQueue<number>();
    const it = queue.iter[Symbol.asyncIterator]();
    const pending = it.next();
    queue.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it("reports done immediately once closed", async () => {
    const queue = makeEventQueue<number>();
    queue.close();
    const it = queue.iter[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("still drains buffered values after close, then reports done", async () => {
    const queue = makeEventQueue<number>();
    queue.push(1);
    queue.close();
    const it = queue.iter[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("drops values pushed after close", async () => {
    const queue = makeEventQueue<number>();
    queue.close();
    queue.push(99);
    const it = queue.iter[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("ends a waiting consumer when the iterator returns early", async () => {
    const queue = makeEventQueue<number>();
    const it = queue.iter[Symbol.asyncIterator]();
    const pending = it.next();
    await it.return?.();
    expect(await pending).toEqual({ value: undefined, done: true });
    // A return() closes the queue, so later pushes are dropped.
    queue.push(1);
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});
