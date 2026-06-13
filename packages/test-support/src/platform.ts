import type { ProviderMessage } from "@spectrum-ts/core";
import { definePlatform, type ManagedStream, stream } from "@spectrum-ts/core";
import z from "zod";

// The fakes resolve sender/space to `{ id: string }`, so the records they emit
// must match the platform's *resolved* message shape (required sender/space) —
// the looser `ProviderMessageRecord` (optional sender/space) is not assignable
// to the `messages` contract. Mirrors the real terminal provider's approach.
type FakeInboundMessage = ProviderMessage<{ id: string }, { id: string }>;

// Placeholder credentials shared by tests that construct Spectrum. Pair with
// stubCloud() so construction never hits the network.
export const baseConfig = {
  projectId: "proj",
  projectSecret: "secret",
} as const;

export const record = (id: string): FakeInboundMessage => ({
  id,
  content: { type: "text", text: "hi" },
  sender: { id: "u1" },
  space: { id: "s1" },
  timestamp: new Date(0),
});

// A queue mirroring the providers' real event queues: a pending next() only
// resolves via push() or close(); the iterator's return() closes it (so a
// stream that drives it can cancel a parked read).
export function makeQueue<T>() {
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
export const makeManagedProvider = (
  name: string,
  opts: { withDestroy?: boolean } = {}
) => {
  const queue = makeQueue<FakeInboundMessage>();
  queue.push(record("m1"));
  return definePlatform(name, {
    config: z.object({}),
    lifecycle: {
      createClient: () => Promise.resolve({}),
      ...(opts.withDestroy ? { destroyClient: () => Promise.resolve() } : {}),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      create: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    messages(): ManagedStream<FakeInboundMessage> {
      return stream<FakeInboundMessage>((emit, end) => {
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

// Provider with a space schema + params schema (the slack/imessage shape) for
// exercising space.create/space.get validation paths. `withGet` toggles a
// provider-implemented `space.get` hook; without it the framework default
// applies — and fails, because the schema requires `extra`.
export const makeSchemaProvider = (
  name: string,
  opts: { withGet?: boolean } = {}
) => {
  // Closed-out queue: an immediately-done inbound stream — these fakes only
  // exercise space resolution, never inbound messages.
  const queue = makeQueue<never>();
  queue.close();
  return definePlatform(name, {
    config: z.object({}),
    lifecycle: {
      createClient: () => Promise.resolve({}),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      schema: z.object({ extra: z.string(), id: z.string() }),
      params: z.object({ extra: z.string() }),
      create: ({ input }) =>
        Promise.resolve({
          extra: input.params?.extra ?? "default",
          id: input.users.map((u) => u.id).join("+"),
        }),
      ...(opts.withGet
        ? {
            get: ({
              input,
            }: {
              input: { id: string; params?: { extra: string } };
            }) =>
              Promise.resolve({
                extra: input.params?.extra ?? "hydrated",
                id: input.id,
              }),
          }
        : {}),
    },
    messages: () => queue.iter,
    send: () => Promise.resolve(undefined),
  });
};

// Provider whose `messages` is a NATIVE async generator blocking on a queue that
// only closes in destroyClient (the terminal-BEFORE-fix shape). Its stream can't
// be cancelled by return(); it relies on the bounded safety net + destroyClient.
export const makeNativeProvider = (name: string) => {
  const queue = makeQueue<FakeInboundMessage>();
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
      create: ({ input }) =>
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
