import { describe, expect, it } from "bun:test";
import { stubCloud } from "@test/support/cloud";
import { baseConfig, makeQueue, record } from "@test/support/platform";
import z from "zod";
import { streamText } from "@/content/stream-text";
import type { Content } from "@/content/types";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage, ProviderMessageRecord } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import { UnsupportedError } from "@/utils/errors";

stubCloud();

const SENT_TIMESTAMP = new Date(123);

type SendImpl = (
  content: Content
) => Promise<ProviderMessageRecord | undefined>;

// One inbound text message, then a `send` whose behavior the test controls.
// Mirrors makeUnsendProvider in send-unsend.test.ts.
const makeProvider = (name: string, sendImpl: SendImpl) => {
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

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
}

// A provider that can't stream: rejects any content carrying a `streamText`
// (top-level or wrapped in reply/edit) but handles everything else, recording
// each dispatch.
const noStreamingSend = (platform: string) => {
  const seen: Content[] = [];
  const sendImpl: SendImpl = (content) => {
    seen.push(content);
    const inner =
      content.type === "reply" || content.type === "edit"
        ? content.content
        : content;
    if (inner.type === "streamText") {
      return Promise.reject(UnsupportedError.content("streamText", platform));
    }
    if (content.type === "edit") {
      // Edits are fire-and-forget; providers may return void.
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      id: `${content.type}-${seen.length}`,
      content,
      space: { id: "s1" },
      timestamp: SENT_TIMESTAMP,
    });
  };
  return { seen, sendImpl };
};

describe("streamText plain-text fallback", () => {
  it("waits for the stream to finish and re-sends the full text", async () => {
    const { seen, sendImpl } = noStreamingSend("stream-fallback-text");
    const provider = makeProvider("stream-fallback-text", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(streamText(chunks("Hello, ", "world!")));

      expect(seen.map((c) => c.type)).toEqual(["streamText", "text"]);
      expect(seen.at(-1)).toEqual({ type: "text", text: "Hello, world!" });
      // The fallback send produces a real Message handle.
      expect(sent?.content).toEqual({ type: "text", text: "Hello, world!" });
    } finally {
      await app.stop();
    }
  });

  it("preserves the reply wrapper (and its target) in the fallback send", async () => {
    const { seen, sendImpl } = noStreamingSend("stream-fallback-reply");
    const provider = makeProvider("stream-fallback-reply", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      const sent = await message.reply(streamText(chunks("a", "b", "c")));

      expect(seen.map((c) => c.type)).toEqual(["reply", "reply"]);
      const fallback = seen.at(-1);
      if (fallback?.type !== "reply") {
        throw new Error("expected a reply fallback dispatch");
      }
      expect(fallback.content).toEqual({ type: "text", text: "abc" });
      expect(fallback.target).toBe(message);
      expect(sent?.id).toBeDefined();
    } finally {
      await app.stop();
    }
  });

  it("preserves the edit wrapper in the fallback send", async () => {
    const { seen, sendImpl } = noStreamingSend("stream-fallback-edit");
    const provider = makeProvider("stream-fallback-edit", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send("hi");
      if (!sent) {
        throw new Error("expected the plain send to produce a message");
      }
      await sent.edit(streamText(chunks("re", "vised")));

      expect(seen.map((c) => c.type)).toEqual(["text", "edit", "edit"]);
      const fallback = seen.at(-1);
      if (fallback?.type !== "edit") {
        throw new Error("expected an edit fallback dispatch");
      }
      expect(fallback.content).toEqual({ type: "text", text: "revised" });
      expect(fallback.target).toBe(sent);
    } finally {
      await app.stop();
    }
  });

  it("skips the fallback when the stream produces no text", async () => {
    const { seen, sendImpl } = noStreamingSend("stream-fallback-empty");
    const provider = makeProvider("stream-fallback-empty", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(streamText(chunks()));

      // Nothing to send — warn-and-skip, no second dispatch.
      expect(sent).toBeUndefined();
      expect(seen.map((c) => c.type)).toEqual(["streamText"]);
    } finally {
      await app.stop();
    }
  });

  it("warn-and-skips when a native driver consumed the stream before failing", async () => {
    const seen: Content[] = [];
    const sendImpl: SendImpl = async (content) => {
      seen.push(content);
      if (content.type === "streamText") {
        // A native driver drains the stream, finds nothing to send, and
        // rejects — re-draining for the fallback is impossible by then.
        let drained = "";
        for await (const delta of content.stream()) {
          drained += delta;
        }
        throw UnsupportedError.content(
          "streamText",
          "stream-consumed",
          `stream produced no text (got "${drained}")`
        );
      }
      return {
        id: `${content.type}-${seen.length}`,
        content,
        space: { id: "s1" },
        timestamp: SENT_TIMESTAMP,
      };
    };
    const provider = makeProvider("stream-consumed", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(streamText(chunks()));

      // The original UnsupportedError lands in warn-and-skip — the consumed
      // stream must not surface as a hard "already consumed" error.
      expect(sent).toBeUndefined();
      expect(seen.map((c) => c.type)).toEqual(["streamText"]);
    } finally {
      await app.stop();
    }
  });

  it("warn-and-skips when the fallback send is unsupported too", async () => {
    const seen: Content[] = [];
    const sendImpl: SendImpl = (content) => {
      seen.push(content);
      return Promise.reject(
        UnsupportedError.content(content.type, "stream-fallback-none")
      );
    };
    const provider = makeProvider("stream-fallback-none", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(streamText(chunks("lost")));

      expect(sent).toBeUndefined();
      expect(seen.map((c) => c.type)).toEqual(["streamText", "text"]);
    } finally {
      await app.stop();
    }
  });

  it("propagates stream errors instead of swallowing them", async () => {
    const { sendImpl } = noStreamingSend("stream-fallback-error");
    const provider = makeProvider("stream-fallback-error", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      async function* boom(): AsyncIterable<string> {
        yield "partial";
        throw new Error("stream blew up");
      }
      await expect(space.send(streamText(boom()))).rejects.toThrow(
        "stream blew up"
      );
    } finally {
      await app.stop();
    }
  });

  it("does not interfere with platforms that stream natively", async () => {
    const seen: Content[] = [];
    const sendImpl: SendImpl = async (content) => {
      seen.push(content);
      if (content.type === "streamText") {
        // A native driver consumes the stream itself and returns the
        // materialized message (the iMessage remote shape).
        let full = "";
        for await (const delta of content.stream()) {
          full += delta;
        }
        return {
          id: "native-1",
          content: { type: "text", text: full },
          space: { id: "s1" },
          timestamp: SENT_TIMESTAMP,
        };
      }
      return {
        id: `${content.type}-${seen.length}`,
        content,
        space: { id: "s1" },
        timestamp: SENT_TIMESTAMP,
      };
    };
    const provider = makeProvider("stream-native", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(streamText(chunks("live ", "stream")));

      expect(seen.map((c) => c.type)).toEqual(["streamText"]);
      expect(sent?.content).toEqual({ type: "text", text: "live stream" });
    } finally {
      await app.stop();
    }
  });
});
