import { describe, expect, it, spyOn } from "bun:test";
import z from "zod";
import type { Content } from "./content/types";
import { definePlatform } from "./platform/define";
import { Spectrum } from "./spectrum";
import { cloud } from "./utils/cloud";
import { type ManagedStream, stream } from "./utils/stream";

// Spectrum() fetches project metadata up-front when credentials are supplied.
// Stub the cloud call so construction doesn't hit the network.
spyOn(cloud, "getProject").mockResolvedValue({
  id: "proj",
  name: "Test Project",
  profile: {},
});

const baseConfig = { projectId: "proj", projectSecret: "secret" } as const;

// Resolve to "resolved" if the promise settles within `ms`, else "timeout".
const withinMs = (p: Promise<unknown>, ms: number): Promise<string> =>
  Promise.race([
    p.then(() => "resolved"),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("timeout"), ms);
    }),
  ]);

// Strict inbound shape (required sender/space) — the `messages` contract wants
// ProviderMessage, not the looser ProviderMessageRecord.
interface TestMessage {
  content: Content;
  id: string;
  sender: { id: string };
  space: { id: string };
  timestamp: Date;
}

const record = (id: string): TestMessage => ({
  id,
  content: { type: "text", text: "hi" } as Content,
  sender: { id: "u1" },
  space: { id: "s1" },
  timestamp: new Date(0),
});

// A queue mirroring the providers' real event queues: a pending next() only
// resolves via push() or close(); the iterator's return() closes it (so a
// stream that drives it can cancel a parked read).
function makeQueue<T>() {
  const buffer: T[] = [];
  const waiters: Array<(r: IteratorResult<T>) => void> = [];
  let closed = false;
  const drain = () => {
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined as never, done: true });
    }
  };
  const iter: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (closed && buffer.length === 0) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          const buffered = buffer.shift();
          if (buffered !== undefined) {
            return Promise.resolve({ value: buffered, done: false });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<T>> {
          closed = true;
          drain();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };
  return {
    iter,
    push(v: T) {
      if (closed) {
        return;
      }
      const w = waiters.shift();
      if (w) {
        w({ value: v, done: false });
      } else {
        buffer.push(v);
      }
    },
    close() {
      closed = true;
      drain();
    },
  };
}

// Provider whose `messages` returns a Repeater ManagedStream (the terminal-after-
// fix / iMessage shape). Its cleanup closes the held queue via the iterator's
// return(), so the stream tears down on stop() WITHOUT needing destroyClient.
const makeManagedProvider = (
  name: string,
  opts: { withDestroy?: boolean } = {}
) => {
  const queue = makeQueue<TestMessage>();
  queue.push(record("m1"));
  return definePlatform(name, {
    config: z.object({}),
    lifecycle: {
      createClient: () => Promise.resolve({}),
      ...(opts.withDestroy ? { destroyClient: () => Promise.resolve() } : {}),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      resolve: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    messages(): ManagedStream<TestMessage> {
      return stream<TestMessage>((emit, end) => {
        const iterator = queue.iter[Symbol.asyncIterator]();
        const pump = (async () => {
          try {
            let result = await iterator.next();
            while (!result.done) {
              await emit(result.value);
              result = await iterator.next();
            }
            end();
          } catch (error) {
            end(error);
          }
        })();
        return async () => {
          await iterator.return?.();
          await pump.catch(() => undefined);
        };
      });
    },
    send: () => Promise.resolve(undefined),
  });
};

// Provider whose `messages` is a NATIVE async generator blocking on a queue that
// only closes in destroyClient (the terminal-BEFORE-fix shape). Its stream can't
// be cancelled by return(); it relies on the bounded safety net + destroyClient.
const makeNativeProvider = (name: string) => {
  const queue = makeQueue<TestMessage>();
  queue.push(record("m1"));
  return definePlatform(name, {
    config: z.object({}),
    lifecycle: {
      createClient: () => Promise.resolve({}),
      destroyClient: () => {
        queue.close();
        return Promise.resolve();
      },
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      resolve: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    async *messages() {
      for await (const value of queue.iter) {
        yield value;
      }
    },
    send: () => Promise.resolve(undefined),
  });
};

describe("Spectrum.stop() shutdown", () => {
  it("managed-stream provider: resolves promptly after consuming a message", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-a", { withDestroy: true }).config({}),
      ],
    });
    const it = app.messages[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);

    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("managed-stream provider with no destroyClient: resolves promptly (stream self-closes)", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [makeManagedProvider("managed-nodestroy").config({})],
    });
    const it = app.messages[Symbol.asyncIterator]();
    await it.next();

    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("multiple managed-stream providers: resolves promptly", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-1", { withDestroy: true }).config({}),
        makeManagedProvider("managed-2").config({}),
      ],
    });
    const it = app.messages[Symbol.asyncIterator]();
    await it.next();

    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("no subscription: resolves promptly", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [
        makeManagedProvider("managed-nosub", { withDestroy: true }).config({}),
      ],
    });
    expect(await withinMs(app.stop(), 1500)).toBe("resolved");
  });

  it("native-generator provider: does not hang — bounded then rescued by destroyClient", async () => {
    const app = await Spectrum({
      ...baseConfig,
      providers: [makeNativeProvider("native").config({})],
    });
    const it = app.messages[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);

    // Can't cancel a parked native generator via return(); the bounded Phase-1
    // wait (STREAM_CLOSE_TIMEOUT_MS) elapses, then destroyClient closes the
    // queue from below. The point is it resolves at all (no infinite hang).
    expect(await withinMs(app.stop(), 9000)).toBe("resolved");
  }, 12_000);
});
