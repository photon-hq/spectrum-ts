import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeQueue,
  record,
} from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { addMember } from "@/content/membership";
import type { Content } from "@/content/types";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage, ProviderMessageRecord } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import { UnsupportedError } from "@/utils/errors";

stubCloud();

const SENT_TIMESTAMP = new Date(123);

const MEMBERSHIP_TYPES = new Set(["addMember", "removeMember", "leaveSpace"]);

type SendImpl = (
  content: Content
) => Promise<ProviderMessageRecord | undefined>;

// One inbound text message, then a `send` whose behavior the test controls.
// Mirrors makeReadProvider in send-read.test.ts.
const makeMembershipProvider = (name: string, sendImpl: SendImpl) => {
  const queue = makeQueue<ProviderMessage<{ id: string }, { id: string }>>();
  queue.push(record("m1"));
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
    send: ({ content }) => sendImpl(content),
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

// Records every dispatched content; membership ops are fire-and-forget
// (void), everything else produces a record so the caller gets a Message.
const recordingSend = () => {
  const seen: Content[] = [];
  const sendImpl: SendImpl = (content) => {
    seen.push(content);
    if (MEMBERSHIP_TYPES.has(content.type)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      id: `${content.type}-1`,
      content,
      space: { id: "s1" },
      timestamp: SENT_TIMESTAMP,
    });
  };
  return { seen, sendImpl };
};

describe("membership sends are fire-and-forget", () => {
  it("space.add() dispatches addMember content with normalized members", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeMembershipProvider("membership-add", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      await space.add("u2");

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("addMember");
      expect((dispatched as { members?: string[] }).members).toEqual(["u2"]);
    } finally {
      await app.stop();
    }
  });

  it("space.add() batches an array into one dispatch", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeMembershipProvider("membership-add-batch", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const before = seen.length;
      await space.add(["u2", "u3"]);

      expect(seen.length).toBe(before + 1);
      const dispatched = seen.at(-1);
      expect((dispatched as { members?: string[] }).members).toEqual([
        "u2",
        "u3",
      ]);
    } finally {
      await app.stop();
    }
  });

  it("space.remove() dispatches removeMember content", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeMembershipProvider("membership-remove", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      await space.remove("u2");

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("removeMember");
      expect((dispatched as { members?: string[] }).members).toEqual(["u2"]);
    } finally {
      await app.stop();
    }
  });

  it("space.leave() dispatches leaveSpace content", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeMembershipProvider("membership-leave", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      await space.leave();

      expect(seen.at(-1)?.type).toBe("leaveSpace");
    } finally {
      await app.stop();
    }
  });

  it("space.send(addMember(...)) resolves undefined", async () => {
    const { sendImpl } = recordingSend();
    const provider = makeMembershipProvider("membership-canonical", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      expect(await space.send(addMember("u2"))).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("resolves silently when the platform does not support membership", async () => {
    const provider = makeMembershipProvider(
      "membership-unsupported",
      (content) => {
        if (MEMBERSHIP_TYPES.has(content.type)) {
          return Promise.reject(
            UnsupportedError.content(content.type, "membership-unsupported")
          );
        }
        return Promise.resolve({
          id: "t1",
          content,
          space: { id: "s1" },
          timestamp: SENT_TIMESTAMP,
        });
      }
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      // Warn-and-skip: the unsupported error is logged, not thrown.
      expect(await space.add("u2")).toBeUndefined();
      expect(await space.remove("u2")).toBeUndefined();
      expect(await space.leave()).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});
