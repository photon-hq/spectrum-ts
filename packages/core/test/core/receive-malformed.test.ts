import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { baseConfig, makeQueue } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage } from "@/platform/types";
import { Spectrum } from "@/spectrum";

stubCloud();

// A provider that declares a message-extras schema (threadId). At runtime a
// provider can still emit a record whose extras don't match that schema (for
// example after an upstream API change) — TypeScript can't express that, so the
// malformed record is pushed through a loosely-typed array + cast.
type ThreadedRecord = ProviderMessage<
  { id: string },
  { id: string },
  { threadId: string }
>;

const makeThreadedProvider = (name: string, records: readonly unknown[]) => {
  const queue = makeQueue<ThreadedRecord>();
  for (const item of records) {
    queue.push(item as ThreadedRecord);
  }
  queue.close();
  return definePlatform(name, {
    config: z.object({}),
    message: { schema: z.object({ threadId: z.string() }) },
    lifecycle: {
      createClient: () => Promise.resolve({}),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      create: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    messages: () => queue.iter,
    send: () => Promise.resolve(undefined),
  });
};

describe("inbound message stream isolation", () => {
  it("skips a record that fails to build and keeps delivering later messages", async () => {
    // `threadId: 123` violates the declared `z.string()` extras schema, so
    // building this record throws inside the inbound pipeline.
    const badRecord = {
      id: "bad",
      content: { type: "text", text: "boom" },
      space: { id: "s1" },
      timestamp: new Date(0),
      threadId: 123,
    };
    const goodRecord = {
      id: "good",
      content: { type: "text", text: "hi" },
      space: { id: "s1" },
      timestamp: new Date(0),
      threadId: "t1",
    };

    const provider = makeThreadedProvider("threaded_isolation", [
      badRecord,
      goodRecord,
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });

    try {
      const iterator = app.messages[Symbol.asyncIterator]();
      // Without per-record isolation the malformed first record tears down the
      // whole merged `messages` stream and this `next()` would reject. With it,
      // the bad record is logged + skipped and the good record is delivered.
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (!first.done) {
        const [, message] = first.value;
        expect(message.content.type).toBe("text");
        if (message.content.type === "text") {
          expect(message.content.text).toBe("hi");
        }
        expect(message.id).toBe("good");
      }
    } finally {
      await app.stop();
    }
  });
});
