import { describe, expect, it } from "bun:test";
import { registerInbound } from "@/providers/chat-sdk/inbound";
import { makeEventQueue } from "@/providers/chat-sdk/queue";
import type {
  ChatBot,
  ChatInboundMessage,
  ChatMessage,
  ChatReactionEvent,
  ChatThread,
} from "@/providers/chat-sdk/types";

type MessageHandler = (
  thread: ChatThread,
  message: ChatMessage
) => void | Promise<void>;
type ReactionHandler = (event: ChatReactionEvent) => void | Promise<void>;

interface Handlers {
  dm?: MessageHandler;
  mention?: MessageHandler;
  reaction?: ReactionHandler;
  subscribed?: MessageHandler;
}

const makeBot = (): { bot: ChatBot; handlers: Handlers } => {
  const handlers: Handlers = {};
  const bot = {
    onNewMention: (h: MessageHandler) => {
      handlers.mention = h;
    },
    onDirectMessage: (h: MessageHandler) => {
      handlers.dm = h;
    },
    onSubscribedMessage: (h: MessageHandler) => {
      handlers.subscribed = h;
    },
    onReaction: (h: ReactionHandler) => {
      handlers.reaction = h;
    },
  } as unknown as ChatBot;
  return { bot, handlers };
};

interface FakeThread extends ChatThread {
  subscribeCount: number;
}

const makeThread = (overrides: Partial<ChatThread> = {}): FakeThread => {
  const thread = {
    id: "T1",
    channelId: "C9",
    subscribeCount: 0,
    adapter: { name: "slack", addReaction: () => Promise.resolve() },
    post: () => Promise.resolve({ id: "S1", threadId: "T1" }),
    postEphemeral: () => Promise.resolve(),
    subscribe() {
      thread.subscribeCount += 1;
      return Promise.resolve();
    },
    ...overrides,
  } as FakeThread;
  return thread;
};

// Pull exactly `n` records off the queue (each push is buffered synchronously,
// so by the time the awaited handler resolves they are all available).
const take = async (
  queue: ReturnType<typeof makeEventQueue<ChatInboundMessage>>,
  n: number
): Promise<ChatInboundMessage[]> => {
  const it = queue.iter[Symbol.asyncIterator]();
  const out: ChatInboundMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push((await it.next()).value);
  }
  return out;
};

const baseMessage = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "M1",
  author: { userId: "U1" },
  text: "hello",
  threadId: "T1",
  ...over,
});

describe("chat-sdk inbound — text messages", () => {
  it("converts a mention into a text record with space + sender + enrichment", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const threads = new Map<string, ChatThread>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, threads);

    const thread = makeThread();
    await handlers.mention?.(thread, baseMessage({ isMention: true }));

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("M1");
    expect(record?.content).toEqual({ type: "text", text: "hello" });
    expect(record?.sender).toEqual({ id: "U1" });
    expect(record?.space).toMatchObject({
      id: "T1",
      adapter: "slack",
      channelId: "C9",
    });
    expect(record?.space.thread).toBe(thread);
    expect(record?.isMention).toBe(true);
  });

  it("stores the live thread in the registry and auto-subscribes", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const threads = new Map<string, ChatThread>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, threads);

    const thread = makeThread();
    await handlers.dm?.(thread, baseMessage());

    expect(threads.get("T1")).toBe(thread);
    expect(thread.subscribeCount).toBe(1);
    await take(queue, 1);
  });

  it("carries edited and link enrichment through", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, new Map());

    const editedAt = new Date("2026-01-01T00:00:00.000Z");
    await handlers.subscribed?.(
      makeThread(),
      baseMessage({
        metadata: { edited: true, editedAt },
        links: [{ url: "https://x.test", title: "X" }],
      })
    );

    const [record] = await take(queue, 1);
    expect(record?.edited).toBe(true);
    expect(record?.editedAt).toEqual(editedAt);
    expect(record?.links).toEqual([{ url: "https://x.test", title: "X" }]);
    expect(record?.isMention).toBeUndefined();
  });

  it("uses message metadata dateSent as the timestamp when present", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, new Map());

    const dateSent = new Date("2026-02-02T12:00:00.000Z");
    await handlers.dm?.(makeThread(), baseMessage({ metadata: { dateSent } }));

    const [record] = await take(queue, 1);
    expect(record?.timestamp).toEqual(dateSent);
  });
});

describe("chat-sdk inbound — attachments", () => {
  it("fans a text+attachment message into a :text and a :file record", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, new Map());

    await handlers.dm?.(
      makeThread(),
      baseMessage({
        attachments: [
          { type: "image", name: "p.png", mimeType: "image/png", url: "u" },
        ],
      })
    );

    const [textRec, fileRec] = await take(queue, 2);
    expect(textRec?.id).toBe("M1:text");
    expect(textRec?.content).toEqual({ type: "text", text: "hello" });
    expect(fileRec?.id).toBe("M1:file:0");
    expect((fileRec?.content as { type: string }).type).toBe("attachment");
  });

  it("uses the bare message id for a single attachment with no text", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, new Map());

    await handlers.dm?.(
      makeThread(),
      baseMessage({
        text: "",
        attachments: [
          { type: "audio", name: "v.ogg", mimeType: "audio/ogg", url: "u" },
        ],
      })
    );

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("M1");
    // Audio attachments surface as voice content.
    expect((record?.content as { type: string }).type).toBe("voice");
  });
});

describe("chat-sdk inbound — reactions", () => {
  it("pushes an added reaction as a reaction record and registers the thread", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const threads = new Map<string, ChatThread>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, threads);

    const thread = makeThread();
    await handlers.reaction?.({
      added: true,
      messageId: "M9",
      rawEmoji: "👍",
      thread,
      threadId: "T1",
      user: { userId: "U2" },
    });

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("reaction:M9:👍");
    expect((record?.content as { type: string }).type).toBe("reaction");
    expect(record?.sender).toEqual({ id: "U2" });
    expect(threads.get("T1")).toBe(thread);
  });

  it("ignores removed reactions", async () => {
    const queue = makeEventQueue<ChatInboundMessage>();
    const threads = new Map<string, ChatThread>();
    const { bot, handlers } = makeBot();
    registerInbound(bot, queue, threads);

    handlers.reaction?.({
      added: false,
      messageId: "M9",
      rawEmoji: "👍",
      thread: makeThread(),
      threadId: "T1",
      user: { userId: "U2" },
    });

    expect(threads.size).toBe(0);
    // Nothing was queued: a close() lets a pull resolve as done rather than hang.
    queue.close();
    const it = queue.iter[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});
