import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeQueue,
  record,
} from "@spectrum-ts/test-support/platform";
import { describe, expect, it } from "vitest";
import z from "zod";
import { group } from "@/content/group";
import { markdown } from "@/content/markdown";
import { poll } from "@/content/poll";
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
// Mirrors makeProvider in send-stream-text-fallback.test.ts.
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

const carriesMarkdown = (content: Content): boolean => {
  if (content.type === "markdown") {
    return true;
  }
  if (content.type === "reply" || content.type === "edit") {
    return content.content.type === "markdown";
  }
  if (content.type === "group") {
    return content.items.some((item) => item.content.type === "markdown");
  }
  return false;
};

// A provider without markdown support: rejects any content carrying a
// `markdown` (top-level, wrapped in reply/edit, or a group item) but handles
// everything else, recording each dispatch.
const noMarkdownSend = (platform: string) => {
  const seen: Content[] = [];
  const sendImpl: SendImpl = (content) => {
    seen.push(content);
    if (carriesMarkdown(content)) {
      return Promise.reject(UnsupportedError.content("markdown", platform));
    }
    if (content.type === "edit") {
      // Edits are fire-and-forget; providers may return void.
      return Promise.resolve(undefined);
    }
    // Groups echo a simple text record: the assertions read `seen`, and a
    // group's stub items carry no provider message ids to wrap.
    return Promise.resolve({
      id: `${content.type}-${seen.length}`,
      content:
        content.type === "group" ? { type: "text", text: "group" } : content,
      space: { id: "s1" },
      timestamp: SENT_TIMESTAMP,
    });
  };
  return { seen, sendImpl };
};

describe("markdown plain-text fallback", () => {
  it("re-sends the markdown as readable plain text", async () => {
    const { seen, sendImpl } = noMarkdownSend("md-fallback-text");
    const provider = makeProvider("md-fallback-text", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(markdown("**Hi** [docs](https://d.test)"));

      expect(seen.map((c) => c.type)).toEqual(["markdown", "text"]);
      expect(seen.at(-1)).toEqual({
        type: "text",
        text: "Hi docs (https://d.test)",
      });
      // The fallback send produces a real Message handle.
      expect(sent?.content).toEqual({
        type: "text",
        text: "Hi docs (https://d.test)",
      });
    } finally {
      await app.stop();
    }
  });

  it("preserves the reply wrapper (and its target) in the fallback send", async () => {
    const { seen, sendImpl } = noMarkdownSend("md-fallback-reply");
    const provider = makeProvider("md-fallback-reply", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [, message] = await firstMessage(app);
      const sent = await message.reply(markdown("**hey**"));

      expect(seen.map((c) => c.type)).toEqual(["reply", "reply"]);
      const fallback = seen.at(-1);
      if (fallback?.type !== "reply") {
        throw new Error("expected a reply fallback dispatch");
      }
      expect(fallback.content).toEqual({ type: "text", text: "hey" });
      expect(fallback.target).toBe(message);
      expect(sent?.id).toBeDefined();
    } finally {
      await app.stop();
    }
  });

  it("preserves the edit wrapper in the fallback send", async () => {
    const { seen, sendImpl } = noMarkdownSend("md-fallback-edit");
    const provider = makeProvider("md-fallback-edit", sendImpl);
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
      await sent.edit(markdown("**revised**"));

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

  it("downgrades markdown group items in place, leaving the rest untouched", async () => {
    const { seen, sendImpl } = noMarkdownSend("md-fallback-group");
    const provider = makeProvider("md-fallback-group", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      await space.send(group(markdown("**caption**"), "plain"));

      expect(seen.map((c) => c.type)).toEqual(["group", "group"]);
      const [first, fallback] = seen;
      if (first?.type !== "group" || fallback?.type !== "group") {
        throw new Error("expected two group dispatches");
      }
      expect(fallback.items.map((item) => item.content)).toEqual([
        { type: "text", text: "caption" },
        { type: "text", text: "plain" },
      ]);
      // Non-markdown members are reused as-is, not rebuilt.
      expect(fallback.items[1]).toBe(
        first.items[1] as (typeof fallback.items)[1]
      );
    } finally {
      await app.stop();
    }
  });

  it("warn-and-skips when the fallback send is unsupported too", async () => {
    const seen: Content[] = [];
    const sendImpl: SendImpl = (content) => {
      seen.push(content);
      return Promise.reject(
        UnsupportedError.content(content.type, "md-fallback-none")
      );
    };
    const provider = makeProvider("md-fallback-none", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(markdown("**lost**"));

      expect(sent).toBeUndefined();
      expect(seen.map((c) => c.type)).toEqual(["markdown", "text"]);
    } finally {
      await app.stop();
    }
  });

  it("warn-and-skips when the markdown renders to empty plain text", async () => {
    const { seen, sendImpl } = noMarkdownSend("md-fallback-empty");
    const provider = makeProvider("md-fallback-empty", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(markdown(" "));

      // Nothing sensible to send — warn-and-skip, no second dispatch.
      expect(sent).toBeUndefined();
      expect(seen.map((c) => c.type)).toEqual(["markdown"]);
    } finally {
      await app.stop();
    }
  });

  it("does not trigger for non-markdown unsupported content", async () => {
    const seen: Content[] = [];
    const sendImpl: SendImpl = (content) => {
      seen.push(content);
      return Promise.reject(
        UnsupportedError.content(content.type, "md-fallback-other")
      );
    };
    const provider = makeProvider("md-fallback-other", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(poll("Q?", "a", "b"));

      expect(sent).toBeUndefined();
      expect(seen.map((c) => c.type)).toEqual(["poll"]);
    } finally {
      await app.stop();
    }
  });

  it("does not interfere with platforms that support markdown natively", async () => {
    const seen: Content[] = [];
    const sendImpl: SendImpl = (content) => {
      seen.push(content);
      return Promise.resolve({
        id: `${content.type}-${seen.length}`,
        content,
        space: { id: "s1" },
        timestamp: SENT_TIMESTAMP,
      });
    };
    const provider = makeProvider("md-native", sendImpl);
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const [space] = await firstMessage(app);
      const sent = await space.send(markdown("**styled**"));

      expect(seen.map((c) => c.type)).toEqual(["markdown"]);
      expect(sent?.content).toEqual({
        type: "markdown",
        markdown: "**styled**",
      });
    } finally {
      await app.stop();
    }
  });
});
