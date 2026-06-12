import { describe, expect, it } from "bun:test";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeQueue,
  record,
} from "@spectrum-ts/test-support/platform";
import z from "zod";
import type { Content } from "@/content/types";
import { unsend } from "@/content/unsend";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage, ProviderMessageRecord } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import { UnsupportedError } from "@/utils/errors";

stubCloud();

const SENT_TIMESTAMP = new Date(123);
const UNDEFINED_TARGET = /unsend\(\) target is undefined/;
const INBOUND_TARGET = /only outbound messages can be unsent/;

type SendImpl = (
  content: Content
) => Promise<ProviderMessageRecord | undefined>;

// One inbound text message, then a `send` whose behavior the test controls.
// Mirrors makeReactionProvider in send-reaction.test.ts.
const makeUnsendProvider = (name: string, sendImpl: SendImpl) => {
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

// Records every dispatched content; unsends are fire-and-forget (void),
// everything else produces a record so the caller gets a Message back.
const recordingSend = () => {
  const seen: Content[] = [];
  const sendImpl: SendImpl = (content) => {
    seen.push(content);
    if (content.type === "unsend") {
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

describe("unsend sends are fire-and-forget", () => {
  it("message.unsend() dispatches unsend content targeting the message", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeUnsendProvider("unsend-ok", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space, message] = await firstMessage(app);
      const sent = await space.send("hi");
      await sent?.unsend();

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("unsend");
      // Identity: the outbound Message handle passes through untouched.
      expect((dispatched as { target?: unknown }).target).toBe(sent);
      expect(message.direction).toBe("inbound");
    } finally {
      await app.stop();
    }
  });

  it("space.send(unsend(message)) resolves undefined", async () => {
    const { sendImpl } = recordingSend();
    const provider = makeUnsendProvider("unsend-canonical", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send("hi");
      expect(await space.send(unsend(sent))).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("space.unsend(message) delegates to the same dispatch", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeUnsendProvider("unsend-space-sugar", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send("hi");
      await space.unsend(sent);

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("unsend");
      expect((dispatched as { target?: unknown }).target).toBe(sent);
    } finally {
      await app.stop();
    }
  });

  it("unsends a reaction via the handle returned by react()", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeUnsendProvider("unsend-reaction", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      const handle = await message.react("👍");
      await handle?.unsend();

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("unsend");
      const target = (dispatched as { target?: unknown }).target;
      expect(target).toBe(handle);
      expect(handle?.content.type).toBe("reaction");
    } finally {
      await app.stop();
    }
  });

  it("resolves silently when the platform does not support unsend", async () => {
    const provider = makeUnsendProvider("unsend-unsupported", (content) => {
      if (content.type === "unsend") {
        return Promise.reject(
          UnsupportedError.content("unsend", "unsend-unsupported")
        );
      }
      return Promise.resolve({
        id: "t1",
        content,
        space: { id: "s1" },
        timestamp: SENT_TIMESTAMP,
      });
    });
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send("hi");
      // Warn-and-skip: the unsupported error is logged, not thrown.
      expect(await sent?.unsend()).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("rejects unsending an inbound message", async () => {
    const { sendImpl } = recordingSend();
    const provider = makeUnsendProvider("unsend-inbound", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      await expect(message.unsend()).rejects.toThrow(INBOUND_TARGET);
    } finally {
      await app.stop();
    }
  });

  it("accepts an unnarrowed send result and throws a clear error when it is undefined", async () => {
    await expect(unsend(undefined).build()).rejects.toThrow(UNDEFINED_TARGET);
  });
});
