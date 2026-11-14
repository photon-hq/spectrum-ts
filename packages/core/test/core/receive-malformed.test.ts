import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { baseConfig, makeQueue } from "@spectrum-ts/test-support/platform";
import { describe, expect, it, vi } from "vitest";
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

// Shared skeleton for a provider that declares the `threadId` extras schema; the
// caller supplies the inbound message source.
const threadedPlatform = (
  name: string,
  messages: () => AsyncIterable<ThreadedRecord>
) =>
  definePlatform(name, {
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
    messages,
    send: () => Promise.resolve(undefined),
  });

const makeThreadedProvider = (name: string, records: readonly unknown[]) => {
  const queue = makeQueue<ThreadedRecord>();
  for (const item of records) {
    queue.push(item as ThreadedRecord);
  }
  queue.close();
  return threadedPlatform(name, () => queue.iter);
};

async function* yieldThenThrow(
  record: ThreadedRecord,
  error: Error
): AsyncGenerator<ThreadedRecord> {
  yield record;
  throw error;
}

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
    // The drop is logged via the lifecycle logger, which mirrors ERROR to
    // `console.error`; capture it so the diagnostic can be asserted below.
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {
      // swallow during the test
    });
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

      // The drop is diagnosed, not silent. Removing the log would leave the skip
      // working but unobservable, so assert the provider and the offending
      // record id are recorded.
      const dropCall = errorLog.mock.calls.find((args) =>
        args.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("dropped an inbound message that failed to build")
        )
      );
      expect(dropCall).toBeDefined();
      const attrs = dropCall?.find(
        (arg): arg is Record<string, unknown> =>
          typeof arg === "object" && arg !== null && "spectrum.provider" in arg
      );
      expect(attrs?.["spectrum.provider"]).toBe("threaded_isolation");
      expect(attrs?.["spectrum.message.id"]).toBe("bad");
    } finally {
      errorLog.mockRestore();
      await app.stop();
    }
  });

  it("still tears the stream down when the provider source itself errors", async () => {
    // A rejection from the provider's own `messages()` iterator is a transport
    // failure, not a single bad record. The per-record guard only isolates build
    // failures, so this error stays terminal: it propagates and ends the merged
    // `messages` stream after the valid record ahead of it is delivered.
    const goodRecord = {
      id: "g1",
      content: { type: "text", text: "hi" },
      space: { id: "s1" },
      timestamp: new Date(0),
      threadId: "t1",
    } as unknown as ThreadedRecord;
    const transportError = new Error("provider transport failed");
    const provider = threadedPlatform("threaded_source_error", () =>
      yieldThenThrow(goodRecord, transportError)
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });

    try {
      const iterator = app.messages[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (!first.done) {
        expect(first.value[1].id).toBe("g1");
      }
      await expect(iterator.next()).rejects.toThrow(
        "provider transport failed"
      );
    } finally {
      await app.stop();
    }
  });
});
