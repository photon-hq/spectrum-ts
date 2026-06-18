import { describe, expect, it } from "bun:test";
import {
  attachment,
  type Content,
  type Message,
  voice,
} from "@spectrum-ts/core";
import {
  asCustom,
  asReaction,
  asRead,
  asText,
} from "@spectrum-ts/core/authoring";
import { type OutboundClient, sendContent } from "@/outbound";
import type { MakeThread } from "@/thread";
import type { ChatSentMessage, ChatThread } from "@/types";

interface ThreadCalls {
  deletes: Array<{ threadId: string; messageId: string }>;
  edits: Array<{ threadId: string; messageId: string; message: unknown }>;
  posts: unknown[];
  reactions: Array<{ threadId: string; messageId: string; emoji: string }>;
  typing: number;
}

// Real `SentMessage` is rich; the tests only read `.id`/`.threadId`.
const SENT = { id: "S1", threadId: "T1" } as unknown as ChatSentMessage;

const makeThreadStub = (
  overrides: Partial<ChatThread> = {}
): { thread: ChatThread; calls: ThreadCalls } => {
  const calls: ThreadCalls = {
    posts: [],
    reactions: [],
    deletes: [],
    edits: [],
    typing: 0,
  };
  const thread = {
    id: "T1",
    adapter: {
      name: "slack",
      addReaction: (threadId: string, messageId: string, emoji: string) => {
        calls.reactions.push({ threadId, messageId, emoji });
        return Promise.resolve();
      },
      deleteMessage: (threadId: string, messageId: string) => {
        calls.deletes.push({ threadId, messageId });
        return Promise.resolve();
      },
      editMessage: (threadId: string, messageId: string, message: unknown) => {
        calls.edits.push({ threadId, messageId, message });
        return Promise.resolve({ id: messageId });
      },
    } as unknown as ChatThread["adapter"],
    post: (message: unknown) => {
      calls.posts.push(message);
      return Promise.resolve(SENT);
    },
    postEphemeral: () => Promise.resolve(),
    startTyping: () => {
      calls.typing += 1;
      return Promise.resolve();
    },
    ...overrides,
  } as unknown as ChatThread;
  return { thread, calls };
};

// A poisoned factory — proves outbound prefers the registered live thread when
// one is present (the factory must never run).
const poisonMakeThread: MakeThread = () => {
  throw new Error("makeThread() should not be reached");
};

const clientWith = (
  registry: Map<string, ChatThread>,
  makeThread: MakeThread
): OutboundClient => ({ label: "slack", threads: registry, makeThread });

const registered = (thread: ChatThread): OutboundClient =>
  clientWith(new Map([["T1", thread]]), poisonMakeThread);

const space = { id: "T1" };
const target = {
  id: "42",
  content: asText("hi"),
} as unknown as Message;

describe("chat-sdk send — body content", () => {
  it("posts text and returns a record carrying the sent id", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(registered(thread), space, asText("hi"));
    expect(calls.posts).toEqual(["hi"]);
    expect(result?.id).toBe("S1");
    expect(result?.space.id).toBe("T1");
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("posts markdown as a markdown postable", async () => {
    const { thread, calls } = makeThreadStub();
    await sendContent(registered(thread), space, {
      type: "markdown",
      markdown: "**hi**",
    } as unknown as Content);
    expect(calls.posts).toEqual([{ markdown: "**hi**" }]);
  });

  it("posts a stream-text content as the live async iterable", async () => {
    const { thread, calls } = makeThreadStub();
    async function* chunks() {
      yield "a";
      yield "b";
    }
    const stream = chunks();
    await sendContent(registered(thread), space, {
      type: "streamText",
      stream: () => stream,
    } as unknown as Content);
    expect(calls.posts).toEqual([stream]);
  });

  it("forwards custom content's raw payload straight to post()", async () => {
    const { thread, calls } = makeThreadStub();
    await sendContent(
      registered(thread),
      space,
      asCustom({ card: { title: "hi" } })
    );
    expect(calls.posts[0]).toEqual({ card: { title: "hi" } });
  });

  it("posts an attachment as a file upload with its name and mime", async () => {
    const { thread, calls } = makeThreadStub();
    await sendContent(
      registered(thread),
      space,
      await attachment(Buffer.from("img"), {
        mimeType: "image/png",
        name: "p.png",
      }).build()
    );
    const posted = calls.posts[0] as {
      markdown: string;
      files: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };
    expect(posted.markdown).toBe("");
    expect(posted.files[0]?.filename).toBe("p.png");
    expect(posted.files[0]?.mimeType).toBe("image/png");
    expect(posted.files[0]?.data.toString()).toBe("img");
  });

  it("posts voice as a file upload", async () => {
    const { thread, calls } = makeThreadStub();
    await sendContent(
      registered(thread),
      space,
      await voice(Buffer.from("a"), {
        mimeType: "audio/ogg",
        name: "v.ogg",
      }).build()
    );
    const posted = calls.posts[0] as {
      files: Array<{ filename: string }>;
    };
    expect(posted.files[0]?.filename).toBe("v.ogg");
  });
});

describe("chat-sdk send — thread resolution", () => {
  it("reconstructs a thread via makeThread for a never-seen space", async () => {
    const { thread, calls } = makeThreadStub();
    // Empty registry forces the factory path.
    await sendContent(
      clientWith(new Map(), () => thread),
      space,
      asText("hi")
    );
    expect(calls.posts).toEqual(["hi"]);
  });
});

describe("chat-sdk send — reply / edit / reaction / unsend", () => {
  it("posts the inner content of a reply into the thread", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(registered(thread), space, {
      type: "reply",
      content: asText("hey"),
      target,
    } as unknown as Content);
    expect(calls.posts).toEqual(["hey"]);
    expect(result?.id).toBe("S1");
  });

  it("adds a reaction via the adapter and returns a synthetic record", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(
      registered(thread),
      space,
      asReaction({ emoji: "👍", target })
    );
    expect(calls.reactions).toEqual([
      { threadId: "T1", messageId: "42", emoji: "👍" },
    ]);
    expect(result?.id).toBe("reaction:42:👍");
    expect((result?.content as { type?: string }).type).toBe("reaction");
  });

  it("edits via the adapter, passing the rendered postable", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(registered(thread), space, {
      type: "edit",
      content: asText("new"),
      target,
    } as unknown as Content);
    expect(calls.edits).toEqual([
      { threadId: "T1", messageId: "42", message: "new" },
    ]);
    // Edit is fire-and-forget — no record is returned.
    expect(result).toBeUndefined();
  });

  it("unsends via the adapter delete", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(registered(thread), space, {
      type: "unsend",
      target,
    } as unknown as Content);
    expect(calls.deletes).toEqual([{ threadId: "T1", messageId: "42" }]);
    expect(result).toBeUndefined();
  });

  it("throws UnsupportedError when the adapter cannot delete", async () => {
    const { thread } = makeThreadStub({
      adapter: {
        name: "discord",
        addReaction: () => Promise.resolve(),
      } as unknown as ChatThread["adapter"],
    });
    await expect(
      sendContent(registered(thread), space, {
        type: "unsend",
        target,
      } as unknown as Content)
    ).rejects.toThrow();
  });

  it("throws UnsupportedError when the adapter cannot edit", async () => {
    const { thread } = makeThreadStub({
      adapter: {
        name: "discord",
        addReaction: () => Promise.resolve(),
      } as unknown as ChatThread["adapter"],
    });
    await expect(
      sendContent(registered(thread), space, {
        type: "edit",
        content: asText("new"),
        target,
      } as unknown as Content)
    ).rejects.toThrow();
  });
});

describe("chat-sdk send — fire-and-forget / no-ops", () => {
  it("starts typing and returns nothing", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(registered(thread), space, {
      type: "typing",
      state: "start",
    } as unknown as Content);
    expect(calls.typing).toBe(1);
    expect(result).toBeUndefined();
  });

  it("treats read as a silent no-op (no generic read-receipt API)", async () => {
    const { thread, calls } = makeThreadStub();
    const result = await sendContent(
      registered(thread),
      space,
      asRead({ target })
    );
    expect(calls.posts).toHaveLength(0);
    expect(result).toBeUndefined();
  });
});

describe("chat-sdk send — unsupported", () => {
  it("throws UnsupportedError for content the SDK cannot express", async () => {
    const { thread } = makeThreadStub();
    await expect(
      sendContent(registered(thread), space, {
        type: "richlink",
        url: "https://x.test",
      } as unknown as Content)
    ).rejects.toThrow();
  });
});
