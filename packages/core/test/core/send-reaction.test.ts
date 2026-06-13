import { describe, expect, it } from "bun:test";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeQueue,
  record,
} from "@spectrum-ts/test-support/platform";
import z from "zod";
import { asReaction, reaction } from "@/content/reaction";
import type { Content } from "@/content/types";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage, ProviderMessageRecord } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";
import { UnsupportedError } from "@/utils/errors";

stubCloud();

const REACTION_TIMESTAMP = new Date(123);
const NO_MESSAGE_ID = /did not return a message id/;
const UNDEFINED_TARGET = /reaction\(\) target is undefined/;

type SendImpl = (
  content: Content
) => Promise<ProviderMessageRecord | undefined>;

// One inbound text message, then a `send` whose reaction behavior the test
// controls. Mirrors makeManagedProvider, minus the stream plumbing the
// shutdown tests need.
const makeReactionProvider = (name: string, sendImpl: SendImpl) => {
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

describe("reaction sends return a Message", () => {
  it("message.react resolves to the reaction Message with the built target", async () => {
    const provider = makeReactionProvider("react-ok", (content) =>
      Promise.resolve({
        id: "r1",
        content,
        space: { id: "s1" },
        timestamp: REACTION_TIMESTAMP,
      })
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      const sent = await message.react("👍");

      expect(sent?.id).toBe("r1");
      expect(sent?.direction).toBe("outbound");
      expect(sent?.timestamp).toEqual(REACTION_TIMESTAMP);
      // `content` is statically narrowed to `Reaction` — no type guard needed.
      expect(sent?.content.type).toBe("reaction");
      expect(sent?.content.emoji).toBe("👍");
      // Identity: the built target passes through wrapping untouched.
      expect(sent?.content.target).toBe(message);
    } finally {
      await app.stop();
    }
  });

  it("space.send(reaction(...)) resolves to the same shape", async () => {
    const provider = makeReactionProvider("react-canonical", (content) =>
      Promise.resolve({
        id: "r2",
        content,
        space: { id: "s1" },
        timestamp: REACTION_TIMESTAMP,
      })
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space, message] = await firstMessage(app);
      const sent = await space.send(reaction("✨", message));

      expect(sent?.id).toBe("r2");
      expect(sent?.direction).toBe("outbound");
      // The `ReactionBuilder` overload narrows `content` statically — no
      // type guard needed, same as `message.react()`.
      expect(sent?.content.type).toBe("reaction");
      expect(sent?.content.emoji).toBe("✨");
      expect(sent?.content.target).toBe(message);
    } finally {
      await app.stop();
    }
  });

  it("resolves undefined when the platform does not support reactions", async () => {
    const provider = makeReactionProvider("react-unsupported", () =>
      Promise.reject(UnsupportedError.content("reaction", "react-unsupported"))
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      expect(await message.react("👍")).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("accepts an unnarrowed send result and throws a clear error when it is undefined", async () => {
    // `space.send` resolves `undefined` when a platform skips unsupported
    // content; the builders accept that union so chained sends compile, and
    // fail with a descriptive error at build time instead.
    await expect(reaction("👍", undefined).build()).rejects.toThrow(
      UNDEFINED_TARGET
    );
  });

  it("rejects when a provider returns no record for a reaction", async () => {
    const provider = makeReactionProvider("react-void", () =>
      Promise.resolve(undefined)
    );
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      await expect(message.react("👍")).rejects.toThrow(NO_MESSAGE_ID);
    } finally {
      await app.stop();
    }
  });
});

describe("inbound reaction target direction", () => {
  const makeInboundReactionProvider = (
    name: string,
    target: ProviderMessageRecord
  ) => {
    const queue = makeQueue<ProviderMessage<{ id: string }, { id: string }>>();
    queue.push({
      id: "reaction-1",
      content: asReaction({
        emoji: "👍",
        target: target as unknown as Message,
      }),
      sender: { id: "u1" },
      space: { id: "s1" },
      timestamp: REACTION_TIMESTAMP,
    });
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

  it("honors a provider-supplied outbound direction on a raw reaction target", async () => {
    const provider = makeInboundReactionProvider("react-target-outbound", {
      id: "bot-message",
      content: { type: "text", text: "from the bot" },
      direction: "outbound",
      space: { id: "s1" },
      timestamp: new Date(0),
    });
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);

      expect(message.direction).toBe("inbound");
      expect(message.content.type).toBe("reaction");
      if (message.content.type === "reaction") {
        expect(message.content.target.direction).toBe("outbound");
        expect(message.content.target.id).toBe("bot-message");
      }
    } finally {
      await app.stop();
    }
  });

  it("keeps the legacy inbound fallback when a raw reaction target has no direction", async () => {
    const provider = makeInboundReactionProvider("react-target-fallback", {
      id: "unknown-message",
      content: { type: "text", text: "unknown owner" },
      space: { id: "s1" },
      timestamp: new Date(0),
    });
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);

      expect(message.content.type).toBe("reaction");
      if (message.content.type === "reaction") {
        expect(message.content.target.direction).toBe("inbound");
      }
    } finally {
      await app.stop();
    }
  });
});
