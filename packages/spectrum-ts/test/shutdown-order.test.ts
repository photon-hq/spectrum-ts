import { describe, expect, it } from "bun:test";
import z from "zod";
import { asText } from "../src/content/text";
import { definePlatform } from "../src/platform/define";
import type { ProviderMessageRecord } from "../src/platform/types";
import { Spectrum } from "../src/spectrum";

const STOP_TIMEOUT_MS = 1000;

const withTimeout = <T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = STOP_TIMEOUT_MS
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    timer.unref?.();
  });

const pending = <T>(): Promise<T> => new Promise(() => undefined);

const record = (id: string, text: string): ProviderMessageRecord => ({
  id,
  content: asText(text),
  sender: { id: `${id}-sender` },
  space: { id: "space-1" },
  timestamp: new Date(0),
});

const destroyGatedDoneIterable = <T>(
  values: readonly T[],
  waitFor: Promise<unknown>,
  events: string[],
  label: string
): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      async next(): Promise<IteratorResult<T>> {
        const value = values[index];
        if (value !== undefined) {
          index += 1;
          return { value, done: false };
        }
        events.push(`${label}:next:start`);
        await waitFor;
        events.push(`${label}:next:end`);
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<T>> {
        return { value: undefined, done: true };
      },
    };
  },
});

const returnImmediateIterable = <T>(
  values: readonly T[]
): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      async next(): Promise<IteratorResult<T>> {
        const value = values[index];
        if (value !== undefined) {
          index += 1;
          return { value, done: false };
        }
        return await pending<IteratorResult<T>>();
      },
      async return(): Promise<IteratorResult<T>> {
        return { value: undefined, done: true };
      },
    };
  },
});

const doneImmediatelyIterable = <T>(): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    return {
      async next(): Promise<IteratorResult<T>> {
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<T>> {
        return { value: undefined, done: true };
      },
    };
  },
});

describe("Spectrum.stop shutdown ordering", () => {
  it("resolves when a provider message stream only exits after destroyClient starts", async () => {
    const events: string[] = [];
    const destroyStarted = Promise.withResolvers<void>();

    const blockingProvider = definePlatform("StopBlockedMessages", {
      config: z.object({}),
      lifecycle: {
        createClient: async () => ({}),
        destroyClient: async () => {
          events.push("destroy:start");
          destroyStarted.resolve();
        },
      },
      user: { resolve: async ({ input }) => ({ id: input.userID }) },
      space: { resolve: async () => ({ id: "space-1" }) },
      messages: () =>
        destroyGatedDoneIterable(
          [],
          destroyStarted.promise,
          events,
          "messages"
        ),
      send: async () => undefined,
    });

    const app = await Spectrum({
      providers: [blockingProvider.config({})],
    });

    const iterator = app.messages[Symbol.asyncIterator]();
    const nextResult = iterator.next();

    await withTimeout(app.stop(), "app.stop()");

    expect(events).toEqual([
      "messages:next:start",
      "destroy:start",
      "messages:next:end",
    ]);
    expect(await withTimeout(nextResult, "app.messages.next()")).toEqual({
      value: undefined,
      done: true,
    });
  });

  it("starts unrelated destroyClient hooks even when one provider stream is blocked", async () => {
    const alphaDestroyStarted = Promise.withResolvers<void>();
    const betaDestroyStarted = Promise.withResolvers<void>();

    const alpha = definePlatform("BlockedAlpha", {
      config: z.object({}),
      lifecycle: {
        createClient: async () => ({}),
        destroyClient: async () => {
          alphaDestroyStarted.resolve();
        },
      },
      user: { resolve: async ({ input }) => ({ id: input.userID }) },
      space: { resolve: async () => ({ id: "space-alpha" }) },
      messages: () =>
        destroyGatedDoneIterable([], alphaDestroyStarted.promise, [], "alpha"),
      send: async () => undefined,
    });

    const beta = definePlatform("IdleBeta", {
      config: z.object({}),
      lifecycle: {
        createClient: async () => ({}),
        destroyClient: async () => {
          betaDestroyStarted.resolve();
        },
      },
      user: { resolve: async ({ input }) => ({ id: input.userID }) },
      space: { resolve: async () => ({ id: "space-beta" }) },
      messages: () => doneImmediatelyIterable<ProviderMessageRecord>(),
      send: async () => undefined,
    });

    const app = await Spectrum({
      providers: [alpha.config({}), beta.config({})],
    });

    const iterator = app.messages[Symbol.asyncIterator]();
    const nextResult = iterator.next();
    const stopPromise = app.stop();

    await withTimeout(
      Promise.all([alphaDestroyStarted.promise, betaDestroyStarted.promise]),
      "destroyClient start"
    );
    await withTimeout(stopPromise, "app.stop()");
    expect(await withTimeout(nextResult, "app.messages.next()")).toEqual({
      value: undefined,
      done: true,
    });
  });

  it("does not let an active platform subscriber block stop()", async () => {
    const destroyStarted = Promise.withResolvers<void>();

    const fanoutProvider = definePlatform("FanoutBlockedSubscriber", {
      config: z.object({}),
      lifecycle: {
        createClient: async () => ({}),
        destroyClient: async () => {
          destroyStarted.resolve();
        },
      },
      user: { resolve: async ({ input }) => ({ id: input.userID }) },
      space: { resolve: async () => ({ id: "space-1" }) },
      messages: () =>
        destroyGatedDoneIterable(
          [record("m1", "first"), record("m2", "second")],
          destroyStarted.promise,
          [],
          "fanout"
        ),
      send: async () => undefined,
    });

    const app = await Spectrum({
      providers: [fanoutProvider.config({})],
    });

    const iterator = fanoutProvider(app).messages[Symbol.asyncIterator]();
    const first = await withTimeout(
      iterator.next(),
      "platform.messages.next()"
    );
    if (first.done) {
      throw new Error("expected first platform message before shutdown");
    }

    await nextTurn();
    await withTimeout(app.stop(), "app.stop()");
  });

  it("resolves when a custom event stream only exits after destroyClient starts", async () => {
    const events: string[] = [];
    const destroyStarted = Promise.withResolvers<void>();

    const customEventsProvider = definePlatform("StopBlockedCustomEvents", {
      config: z.object({}),
      lifecycle: {
        createClient: async () => ({}),
        destroyClient: async () => {
          events.push("destroy:start");
          destroyStarted.resolve();
        },
      },
      user: { resolve: async ({ input }) => ({ id: input.userID }) },
      space: { resolve: async () => ({ id: "space-1" }) },
      messages: () => returnImmediateIterable<ProviderMessageRecord>([]),
      events: {
        presence: () =>
          destroyGatedDoneIterable(
            [],
            destroyStarted.promise,
            events,
            "presence"
          ),
      },
      send: async () => undefined,
    });

    const app = await Spectrum({
      providers: [customEventsProvider.config({})],
    });

    const presence = (app as typeof app & { presence: AsyncIterable<unknown> })
      .presence;
    const iterator = presence[Symbol.asyncIterator]();
    const nextResult = iterator.next();

    await withTimeout(app.stop(), "app.stop()");

    expect(events).toEqual([
      "presence:next:start",
      "destroy:start",
      "presence:next:end",
    ]);
    expect(await withTimeout(nextResult, "presence.next()")).toEqual({
      value: undefined,
      done: true,
    });
  });
});
