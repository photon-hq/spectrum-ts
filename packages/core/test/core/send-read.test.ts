import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeQueue,
  record,
} from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { read } from "@/content/read";
import type { Content } from "@/content/types";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage, ProviderMessageRecord } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import { UnsupportedError } from "@/utils/errors";

stubCloud();

const SENT_TIMESTAMP = new Date(123);
const OUTBOUND_TARGET = /only inbound messages can be marked read/;

type SendImpl = (
  content: Content
) => Promise<ProviderMessageRecord | undefined>;

// One inbound text message, then a `send` whose behavior the test controls.
// Mirrors makeUnsendProvider in send-unsend.test.ts.
const makeReadProvider = (name: string, sendImpl: SendImpl) => {
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

// Records every dispatched content; reads are fire-and-forget (void),
// everything else produces a record so the caller gets a Message back.
const recordingSend = () => {
  const seen: Content[] = [];
  const sendImpl: SendImpl = (content) => {
    seen.push(content);
    if (content.type === "read") {
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

describe("read sends are fire-and-forget", () => {
  it("message.read() dispatches read content targeting the message", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeReadProvider("read_ok", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      await message.read();

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("read");
      // Identity: the inbound Message handle passes through untouched.
      expect((dispatched as { target?: unknown }).target).toBe(message);
    } finally {
      await app.stop();
    }
  });

  it("space.send(read(message)) resolves undefined", async () => {
    const { sendImpl } = recordingSend();
    const provider = makeReadProvider("read_canonical", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space, message] = await firstMessage(app);
      expect(await space.send(read(message))).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("space.read(message) delegates to the same dispatch", async () => {
    const { seen, sendImpl } = recordingSend();
    const provider = makeReadProvider("read_space_sugar", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space, message] = await firstMessage(app);
      await space.read(message);

      const dispatched = seen.at(-1);
      expect(dispatched?.type).toBe("read");
      expect((dispatched as { target?: unknown }).target).toBe(message);
    } finally {
      await app.stop();
    }
  });

  it("resolves silently when the platform does not support read", async () => {
    const provider = makeReadProvider("read_unsupported", (content) => {
      if (content.type === "read") {
        return Promise.reject(
          UnsupportedError.content("read", "read_unsupported")
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
      const [, message] = await firstMessage(app);
      // Warn-and-skip: the unsupported error is logged, not thrown.
      expect(await message.read()).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("rejects marking an outbound message as read", async () => {
    const { sendImpl } = recordingSend();
    const provider = makeReadProvider("read_outbound", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send("hi");
      await expect(sent?.read()).rejects.toThrow(OUTBOUND_TARGET);
    } finally {
      await app.stop();
    }
  });
});
