import { describe, expect, test } from "bun:test";
import z from "zod";
import { asText } from "../content/text";
import { definePlatform } from "../platform/define";
import type { ProviderMessage } from "../platform/types";
import { Spectrum } from "../spectrum";

interface TestQueue<T> extends AsyncIterable<T> {
  close: () => void;
  push: (value: T) => void;
}

function createQueue<T>(): TestQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value) {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
        return;
      }
      values.push(value);
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            const value = values.shift() as T;
            return Promise.resolve({ done: false, value });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return() {
          closed = true;
          while (waiters.length > 0) {
            waiters.shift()?.({ done: true, value: undefined });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

describe("platform space metadata", () => {
  test("preserves provider-emitted space extras into provider send", async () => {
    let observedResponseSessionId: unknown;
    const queue =
      createQueue<
        ProviderMessage<
          { id: string },
          { id: string; requestId: string; responseSessionId: string }
        >
      >();
    const platform = definePlatform("metadata-test", {
      config: z.object({}),
      lifecycle: {
        createClient: async () => queue,
        destroyClient: async ({ client }) => {
          client.close();
        },
      },
      user: {
        resolve: async ({ input }) => ({ id: input.userID }),
      },
      space: {
        resolve: async () => ({ id: "test-space" }),
      },
      async *messages({ client }) {
        for await (const message of client) {
          yield message;
        }
      },
      send: async ({ content, space }) => {
        observedResponseSessionId = (space as { responseSessionId?: unknown })
          .responseSessionId;
        return {
          id: "outbound-1",
          content,
          space,
          timestamp: new Date(),
        };
      },
    });

    const app = await Spectrum({
      providers: [platform.config()],
    });
    const iterator = app.messages[Symbol.asyncIterator]();

    try {
      queue.push({
        id: "inbound-1",
        content: asText("hello"),
        sender: { id: "user-1" },
        space: {
          id: "test-space",
          requestId: "request-1",
          responseSessionId: "session-1",
        },
      });

      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (next.done) {
        throw new Error("Expected inbound message");
      }

      await next.value[0].send("reply");

      expect(observedResponseSessionId).toBe("session-1");
    } finally {
      queue.close();
      await app.stop();
    }
  });
});
