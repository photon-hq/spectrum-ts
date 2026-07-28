import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { baseConfig, makeQueue } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";

stubCloud();

const READ_AT = new Date(789);

type InboundRecord = ProviderMessage<{ id: string }, { id: string }>;

// Providers surface a read receipt as an inbound record whose content is
// `read`, with the target being one of *our* outbound messages. The target
// arrives as a raw record; `wrapNestedContent` is what turns it into a Message.
const makeInboundProvider = (name: string, records: InboundRecord[]) => {
  const queue = makeQueue<InboundRecord>();
  for (const item of records) {
    queue.push(item);
  }
  queue.close();
  return definePlatform(name, {
    config: z.object({}),
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

const firstMessage = async (app: Awaited<ReturnType<typeof Spectrum>>) => {
  const iterator = app.messages[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    throw new Error("expected an inbound message");
  }
  return first.value;
};

const rawTarget = {
  id: "m-out",
  content: { type: "text", text: "hi" },
  direction: "outbound",
  space: { id: "s1" },
  timestamp: new Date(123),
};

const readRecord = (content: unknown): InboundRecord =>
  ({
    id: "evt-read-1",
    content,
    sender: { id: "+15550111" },
    space: { id: "s1" },
    timestamp: READ_AT,
  }) as unknown as InboundRecord;

describe("inbound read receipts", () => {
  it("builds the target as an outbound Message", async () => {
    const provider = makeInboundProvider("read_inbound", [
      readRecord({ type: "read", target: rawTarget }),
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space, message] = await firstMessage(app);

      expect(message.direction).toBe("inbound");
      expect(message.content.type).toBe("read");
      expect(message.timestamp).toEqual(READ_AT);

      const target = (message.content as { target: Message }).target;
      // The whole point of the `wrapNestedContent` read arm: the target is a
      // fully-built Message, not the raw record the provider handed over.
      expect(typeof target.reply).toBe("function");
      expect(typeof target.unsend).toBe("function");
      expect(target.direction).toBe("outbound");
      expect(target.platform).toBe("read_inbound");
      expect(target.id).toBe("m-out");
      expect(target.content).toEqual({ type: "text", text: "hi" });
      expect(target.space).toBe(space);
    } finally {
      await app.stop();
    }
  });

  it("tags the reader as the message sender", async () => {
    const provider = makeInboundProvider("read_inbound_sender", [
      readRecord({ type: "read", target: rawTarget }),
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      expect(message.sender?.id).toBe("+15550111");
    } finally {
      await app.stop();
    }
  });

  it("leaves an already-built target untouched", async () => {
    // Pins that the new arm is inert whenever the target is not a raw record —
    // `isRawProviderRecord` rejects anything carrying `react`/`reply`.
    const built = {
      ...rawTarget,
      react: () => Promise.resolve(undefined),
      reply: () => Promise.resolve(undefined),
    };
    const provider = makeInboundProvider("read_inbound_built", [
      readRecord({ type: "read", target: built }),
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      expect((message.content as { target: unknown }).target).toBe(built);
    } finally {
      await app.stop();
    }
  });
});
