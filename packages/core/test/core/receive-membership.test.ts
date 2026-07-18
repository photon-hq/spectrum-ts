import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { baseConfig, makeQueue } from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage } from "@/platform/types";
import { Spectrum } from "@/spectrum";

stubCloud();

const EVENT_TIMESTAMP = new Date(456);

type InboundRecord = ProviderMessage<{ id: string }, { id: string }>;

// Providers surface platform group events as inbound records whose content
// is membership; `sender` may be absent when no actor was recorded.
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

describe("inbound membership events", () => {
  it("delivers a sender-less membership event with content intact", async () => {
    const provider = makeInboundProvider("membership-inbound", [
      {
        id: "evt-1",
        content: { type: "addMember", members: ["+15550100"] },
        space: { id: "s1" },
        timestamp: EVENT_TIMESTAMP,
      },
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space, message] = await firstMessage(app);
      expect(space.id).toBe("s1");
      expect(message.content).toEqual({
        type: "addMember",
        members: ["+15550100"],
      });
      expect(message.direction).toBe("inbound");
      expect(message.sender).toBeUndefined();
      expect(message.timestamp).toEqual(EVENT_TIMESTAMP);
    } finally {
      await app.stop();
    }
  });

  it("tags an inbound membership sender with the platform", async () => {
    const provider = makeInboundProvider("membership-inbound-sender", [
      {
        id: "evt-2",
        content: { type: "removeMember", members: ["+15550100"] },
        sender: { id: "+15550111" },
        space: { id: "s1" },
        timestamp: EVENT_TIMESTAMP,
      },
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      expect(message.content.type).toBe("removeMember");
      expect(message.sender).toEqual({
        id: "+15550111",
        __platform: "membership-inbound-sender",
      });
    } finally {
      await app.stop();
    }
  });

  it("delivers leaveSpace with the leaver as sender", async () => {
    const provider = makeInboundProvider("membership-inbound-leave", [
      {
        id: "evt-3",
        content: { type: "leaveSpace" },
        sender: { id: "+15550122" },
        space: { id: "s1" },
        timestamp: EVENT_TIMESTAMP,
      },
    ]);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      expect(message.content).toEqual({ type: "leaveSpace" });
      expect(message.sender?.id).toBe("+15550122");
    } finally {
      await app.stop();
    }
  });
});
