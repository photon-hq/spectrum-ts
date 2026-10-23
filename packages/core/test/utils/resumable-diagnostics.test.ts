import { makeQueue } from "@spectrum-ts/test-support/platform";
import { flush } from "@spectrum-ts/test-support/timing";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  type ResumableOrderedStreamOptions,
  resumableOrderedStream,
} from "@/utils/resumable-stream";
import { mergeStreams } from "@/utils/stream";
import { createStreamGroup } from "@/utils/stream-group";

const log = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@photon-ai/otel", async (original) => ({
  ...(await original<typeof import("@photon-ai/otel")>()),
  createLogger: () => log,
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => vi.useRealTimers());

const identity = {
  provider: "fixture",
  projectId: "project",
  lineId: "line",
  stream: "messages",
  subscriptionId: "generation-1",
};
const item = (event: number) => ({
  id: String(event),
  cursor: String(event),
  values: [event],
});
const empty = () => {
  const queue = makeQueue<number>();
  queue.close();
  return queue.iter;
};
const pendingWarnings = () =>
  log.warn.mock.calls.filter(
    ([message]) => message === "stream operation still pending"
  );
const settlements = () =>
  log.info.mock.calls.filter(
    ([message]) => message === "previously pending stream operation settled"
  );
const fixture = (
  options: Partial<ResumableOrderedStreamOptions<number, number, number>> = {},
  withMetadata = true
) => {
  const queue = makeQueue<number>();
  const source = resumableOrderedStream<number, number, number>({
    label: "do-not-log-this-phone-+15551234567",
    fetchMissed: empty,
    processLive: async (event) => item(event),
    processMissed: async (event) => item(event),
    eventDiagnosticAttrs: (event) => ({
      "spectrum.stream.event_cursor": String(event),
    }),
    subscribeLive: () =>
      Object.assign(queue.iter, {
        close: queue.close,
        diagnosticAttrs: withMetadata ? identity : undefined,
      }),
    ...options,
  });
  const iterator = source[Symbol.asyncIterator]();
  const first = iterator.next();
  return { source, queue, iterator, first };
};

it.each([
  "close",
  "return",
  "detach",
] as const)("%s starts subscription cleanup before a blocked mapper settles", async (method) => {
  const queue = makeQueue<number>();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const close = vi.fn(queue.close);
  const source = resumableOrderedStream({
    fetchMissed: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
    }),
    processLive: async (event: number) => {
      entered.resolve();
      await release.promise;
      return { id: String(event), cursor: String(event), values: [event] };
    },
    processMissed: async () => ({ id: "unused", values: [] }),
    subscribeLive: () =>
      Object.assign(queue.iter, { close, diagnosticAttrs: identity }),
  });
  const group = createStreamGroup<number>();
  group.add("line", () => mergeStreams([source]));
  const iterator = group[Symbol.asyncIterator]();
  const first = iterator.next();
  queue.push(1);
  await entered.promise;
  let settled = false;
  const stop = {
    close: () => group.close(),
    return: () => iterator.return?.(),
    detach: () => group.remove("line"),
  };
  const stopped = Promise.resolve(stop[method]()).then(() => {
    settled = true;
  });
  try {
    await flush();
    expect(close).toHaveBeenCalled();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pendingWarnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
    await stopped;
    await group.close();
    await first;
  }
});

it("warns once for pending mapping without timing out or advancing the resume cursor", async () => {
  const release = Promise.withResolvers<void>();
  const processLive = vi.fn(async (event: number) => {
    await release.promise;
    return item(event);
  });
  const fx = fixture({ processLive });
  onTestFinished(async () => {
    release.resolve();
    await fx.source.close();
    await fx.first;
  });
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    fx.queue.push(7);
    await flush();
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(timers.mock.results[0]?.value.hasRef()).toBe(false);
  } finally {
    timers.mockRestore();
  }
  await vi.advanceTimersByTimeAsync(29_999);
  expect(pendingWarnings()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(pendingWarnings()).toHaveLength(1);
  expect(pendingWarnings()[0]?.[1]).toMatchObject({
    ...identity,
    "spectrum.stream.id": expect.any(String),
    "spectrum.stream.origin": "live",
    "spectrum.stream.subscription_role": "source",
    "spectrum.stream.operation": "mapping",
    "spectrum.stream.event_cursor": "7",
    "spectrum.stream.cursor": undefined,
    "spectrum.stream.pending_ms": 30_000,
  });
  expect(JSON.stringify(pendingWarnings())).not.toContain("+15551234567");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pendingWarnings()).toHaveLength(1);
  expect(processLive).toHaveBeenCalledTimes(1);
  release.resolve();
  expect((await fx.first).value).toBe(7);
  expect(settlements()[0]?.[1]).toMatchObject({
    "spectrum.stream.operation": "mapping",
    "spectrum.stream.outcome": "completed",
  });
});

it("identifies application emission backpressure separately from mapping", async () => {
  const fx = fixture();
  onTestFinished(async () => {
    await fx.source.close();
    await fx.first;
  });
  fx.queue.push(1);
  expect((await fx.first).value).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pendingWarnings()).toHaveLength(1);
  expect(pendingWarnings()[0]?.[1]).toMatchObject({
    ...identity,
    "spectrum.stream.operation": "emit",
    "spectrum.stream.event_cursor": "1",
    "spectrum.stream.cursor": undefined,
  });
  const next = fx.iterator.next();
  await flush();
  expect(settlements()[0]?.[1]).toMatchObject({
    "spectrum.stream.operation": "emit",
    "spectrum.stream.outcome": "completed",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pendingWarnings()).toHaveLength(1);
  await fx.source.close();
  expect((await next).done).toBe(true);
});

it("does not arm diagnostics for a quiet live read or a source without metadata", async () => {
  const quiet = fixture();
  const release = Promise.withResolvers<void>();
  const unconfigured = fixture(
    {
      processLive: async (event) => {
        await release.promise;
        return item(event);
      },
    },
    false
  );
  onTestFinished(async () => {
    release.resolve();
    await Promise.all([quiet.source.close(), unconfigured.source.close()]);
    await Promise.all([quiet.first, unconfigured.first]);
  });
  unconfigured.queue.push(1);
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(pendingWarnings()).toHaveLength(0);
});

it("does not let diagnostic extraction or logger failures change delivery", async () => {
  const release = Promise.withResolvers<void>();
  const fx = fixture({
    processLive: async (event) => {
      await release.promise;
      return item(event);
    },
    eventDiagnosticAttrs: () => {
      throw new Error("private diagnostic error");
    },
  });
  onTestFinished(async () => {
    release.resolve();
    await fx.source.close();
    await fx.first;
  });
  fx.queue.push(8);
  await flush();
  log.warn.mockImplementationOnce(() => {
    throw new Error("log failure");
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pendingWarnings()[0]?.[1]).toMatchObject(identity);
  expect(JSON.stringify(pendingWarnings())).not.toContain(
    "private diagnostic error"
  );
  log.info.mockImplementationOnce(() => {
    throw new Error("log failure");
  });
  release.resolve();
  expect((await fx.first).value).toBe(8);
});

it("reports a failed pending call without replacing its error or retry policy", async () => {
  const release = Promise.withResolvers<void>();
  const failure = new Error("original mapper failure");
  const fx = fixture({
    processLive: async (event) => {
      await release.promise;
      return item(event);
    },
  });
  onTestFinished(async () => {
    release.resolve();
    await fx.source.close();
    await fx.first;
  });
  fx.queue.push(1);
  await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  log.info.mockImplementationOnce(() => {
    throw new Error("diagnostic logger failure");
  });
  release.reject(failure);
  await flush();
  expect(settlements()[0]?.[1]).toMatchObject({
    "spectrum.stream.operation": "mapping",
    "spectrum.stream.outcome": "failed",
  });
  expect(log.warn).toHaveBeenCalledWith(
    "stream interrupted; reconnecting",
    expect.objectContaining({
      "spectrum.stream.attempt": 1,
      "spectrum.stream.delay_ms": 500,
    }),
    failure
  );
});

it("keeps reconnect, catch-up, buffered-live, and subsequent live provenance separate", async () => {
  const queues = [makeQueue<number>(), makeQueue<number>()];
  const gates = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  let generation = 0;
  const fx = fixture({
    initialRetryDelayMs: 0,
    subscribeLive: () => {
      const queue = queues[generation++];
      if (!queue) {
        throw new Error("unexpected reconnect");
      }
      return Object.assign(queue.iter, {
        close: queue.close,
        diagnosticAttrs: {
          ...identity,
          subscriptionId: `generation-${generation}`,
        },
      });
    },
    async *fetchMissed() {
      yield 2;
    },
    processMissed: async (event) => {
      await gates[0]?.promise;
      return item(event);
    },
    processLive: async (event) => {
      if (event === 3) {
        await gates[1]?.promise;
      }
      if (event === 4) {
        await gates[2]?.promise;
      }
      return item(event);
    },
  });
  onTestFinished(async () => {
    for (const gate of gates) {
      gate.resolve();
    }
    await fx.source.close();
    await fx.first;
  });
  queues[0]?.push(1);
  expect((await fx.first).value).toBe(1);
  const second = fx.iterator.next();
  queues[0]?.close();
  await flush();
  expect(generation).toBe(2);
  queues[1]?.push(3);
  await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pendingWarnings()[0]?.[1]).toMatchObject({
    subscriptionId: "generation-2",
    "spectrum.stream.origin": "catch-up",
    "spectrum.stream.subscription_role": "concurrent-live",
    "spectrum.stream.event_cursor": "2",
    "spectrum.stream.cursor": "1",
    "spectrum.stream.operation": "mapping",
  });
  gates[0]?.resolve();
  expect((await second).value).toBe(2);
  const third = fx.iterator.next();
  await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pendingWarnings()[1]?.[1]).toMatchObject({
    subscriptionId: "generation-2",
    "spectrum.stream.origin": "buffered-live",
    "spectrum.stream.subscription_role": "source",
    "spectrum.stream.event_cursor": "3",
    "spectrum.stream.cursor": "2",
  });
  gates[1]?.resolve();
  expect((await third).value).toBe(3);
  const fourth = fx.iterator.next();
  await flush();
  queues[1]?.push(4);
  await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pendingWarnings()[2]?.[1]).toMatchObject({
    subscriptionId: "generation-2",
    "spectrum.stream.origin": "live",
    "spectrum.stream.event_cursor": "4",
    "spectrum.stream.cursor": "3",
  });
  gates[2]?.resolve();
  expect((await fourth).value).toBe(4);
  expect(pendingWarnings()).toHaveLength(3);
  expect(settlements()).toHaveLength(3);
});
