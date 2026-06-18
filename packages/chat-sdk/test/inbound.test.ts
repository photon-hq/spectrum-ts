import { describe, expect, it } from "bun:test";
import { SpectrumChatHost } from "@/host";
import { makeEventQueue } from "@/queue";
import type {
  ChatAdapter,
  ChatInboundMessage,
  ChatMessage,
  ChatThread,
} from "@/types";
import { author, noopLogger, reactionEvent } from "./_fixtures";

const makeAdapter = (): ChatAdapter =>
  ({
    name: "slack",
    initialize: () => Promise.resolve(),
    channelIdFromThreadId: () => "C9",
    handleWebhook: () => Promise.resolve(new Response()),
    addReaction: () => Promise.resolve(),
  }) as unknown as ChatAdapter;

const makeThreadStub = (over: Partial<ChatThread> = {}): ChatThread =>
  ({
    id: "T1",
    channelId: "C9",
    adapter: {
      name: "slack",
      addReaction: () => Promise.resolve(),
    } as unknown as ChatThread["adapter"],
    post: () => Promise.resolve({ id: "S1", threadId: "T1" }),
    postEphemeral: () => Promise.resolve(),
    ...over,
  }) as ChatThread;

// Wire a host over a single adapter, with `makeThread` returning a fixed stub so
// the cached/stamped thread is observable. This is the host the adapter would
// call `handleIncomingMessage` / `processMessage` / `processReaction` on.
const setup = (over: { state?: unknown } = {}) => {
  const queue = makeEventQueue<ChatInboundMessage>();
  const threads = new Map<string, ChatThread>();
  const adapter = makeAdapter();
  const thread = makeThreadStub();
  const host = new SpectrumChatHost({
    adapter,
    userName: "bot",
    state: over.state ?? {},
    logger: noopLogger,
    queue,
    threads,
    makeThread: () => thread,
  });
  return { host, queue, threads, adapter, thread };
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

// Real `ChatMessage` is the `Message` class; tests build the partial shape the
// converters read and cast through `unknown`.
const baseMessage = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: "M1",
    author: author("U1"),
    text: "hello",
    threadId: "T1",
    ...over,
  }) as unknown as ChatMessage;

describe("chat-sdk inbound — text messages", () => {
  it("converts a message into a text record with space + sender + enrichment", async () => {
    const { host, queue, adapter, thread } = setup();

    host.handleIncomingMessage(adapter, "T1", baseMessage({ isMention: true }));

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

  it("caches the live thread in the registry", async () => {
    const { host, queue, threads, adapter, thread } = setup();

    host.handleIncomingMessage(adapter, "T1", baseMessage());

    // Ingest is async (dedupe awaits state); the thread is cached by the time
    // the record lands on the queue.
    await take(queue, 1);
    expect(threads.get("T1")).toBe(thread);
  });

  it("carries edited and link enrichment through (Linear processMessage path)", async () => {
    const { host, queue, adapter } = setup();

    const editedAt = new Date("2026-01-01T00:00:00.000Z");
    await host.processMessage(
      adapter,
      "T1",
      baseMessage({
        metadata: { dateSent: new Date(), edited: true, editedAt },
        links: [{ url: "https://x.test", title: "X" }],
      })
    );

    const [record] = await take(queue, 1);
    expect(record?.edited).toBe(true);
    expect(record?.editedAt).toEqual(editedAt);
    expect(record?.links).toEqual([{ url: "https://x.test", title: "X" }]);
    expect(record?.isMention).toBeUndefined();
  });

  it("resolves the lazy message factory in processMessage", async () => {
    const { host, queue, adapter } = setup();

    await host.processMessage(adapter, "T1", () =>
      Promise.resolve(baseMessage({ text: "lazy" }))
    );

    const [record] = await take(queue, 1);
    expect(record?.content).toEqual({ type: "text", text: "lazy" });
  });

  it("uses message metadata dateSent as the timestamp when present", async () => {
    const { host, queue, adapter } = setup();

    const dateSent = new Date("2026-02-02T12:00:00.000Z");
    host.handleIncomingMessage(
      adapter,
      "T1",
      baseMessage({ metadata: { dateSent, edited: false } })
    );

    const [record] = await take(queue, 1);
    expect(record?.timestamp).toEqual(dateSent);
  });

  it("drops the bot's own messages (author.isMe) so replies don't loop", async () => {
    const { host, queue, threads, adapter } = setup();

    // The self-authored message is dropped: it caches no thread...
    host.handleIncomingMessage(
      adapter,
      "T1",
      baseMessage({ id: "SELF", author: author("U1", { isMe: true }) })
    );
    expect(threads.get("T1")).toBeUndefined();

    // ...and a following real message is the first record off the queue,
    // proving nothing was queued for the self-message.
    host.handleIncomingMessage(adapter, "T1", baseMessage({ id: "M2" }));
    const [record] = await take(queue, 1);
    expect(record?.id).toBe("M2");
  });

  it("dedupes a redelivered message id (e.g. a retried webhook)", async () => {
    // A state adapter exposing `setIfNotExists` opts the host into dedupe; the
    // default test `state: {}` does not, so other tests are unaffected.
    const seen = new Set<string>();
    const dedupeState = {
      setIfNotExists: (key: string) => {
        if (seen.has(key)) {
          return Promise.resolve(false);
        }
        seen.add(key);
        return Promise.resolve(true);
      },
    };
    const { host, queue, adapter } = setup({ state: dedupeState });

    // Same id twice; only the first is surfaced. A different id still flows,
    // and being the second record off the queue proves the redelivery was dropped.
    await host.processMessage(adapter, "T1", baseMessage({ id: "DUP" }));
    await host.processMessage(adapter, "T1", baseMessage({ id: "DUP" }));
    await host.processMessage(adapter, "T1", baseMessage({ id: "NEW" }));

    const records = await take(queue, 2);
    expect(records.map((r) => r.id)).toEqual(["DUP", "NEW"]);
  });
});

describe("chat-sdk inbound — attachments", () => {
  it("fans a text+attachment message into a :text and a :file record", async () => {
    const { host, queue, adapter } = setup();

    host.handleIncomingMessage(
      adapter,
      "T1",
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
    const { host, queue, adapter } = setup();

    host.handleIncomingMessage(
      adapter,
      "T1",
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

describe("chat-sdk inbound — links", () => {
  it("fans a link into a richlink record built from the unfurled metadata", async () => {
    const { host, queue, adapter } = setup();

    host.handleIncomingMessage(
      adapter,
      "T1",
      baseMessage({
        links: [
          {
            url: "https://x.test/post",
            title: "Title",
            description: "Summary",
            imageUrl: "https://x.test/cover.png",
          },
        ],
      })
    );

    const [textRec, linkRec] = await take(queue, 2);
    expect(textRec?.id).toBe("M1:text");
    expect((textRec?.content as { type: string }).type).toBe("text");
    // Enrichment links are retained for back-compat alongside the record.
    expect(textRec?.links).toHaveLength(1);

    expect(linkRec?.id).toBe("M1:link:0");
    const content = linkRec?.content as {
      type: string;
      url: string;
      title: () => Promise<string | undefined>;
      summary: () => Promise<string | undefined>;
    };
    expect(content.type).toBe("richlink");
    expect(content.url).toBe("https://x.test/post");
    // Accessors resolve the supplied metadata without any network fetch.
    expect(await content.title()).toBe("Title");
    expect(await content.summary()).toBe("Summary");
  });

  it("skips a malformed link url without dropping the message", async () => {
    const { host, queue, adapter } = setup();

    host.handleIncomingMessage(
      adapter,
      "T1",
      baseMessage({ links: [{ url: "not a url" }] })
    );

    // Only the text record survives — the bad link is skipped, not thrown.
    const [textRec] = await take(queue, 1);
    expect((textRec?.content as { type: string }).type).toBe("text");
  });
});

describe("chat-sdk inbound — empty messages", () => {
  it("surfaces a message with no text/attachments/links as a custom record", async () => {
    const { host, queue, adapter } = setup();

    const raw = { kind: "sticker", id: "sticker-1" };
    host.handleIncomingMessage(adapter, "T1", baseMessage({ text: "", raw }));

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("M1");
    expect(record?.content).toEqual({
      type: "custom",
      raw: { chatsdk_type: "empty", raw },
    });
    expect(record?.sender).toEqual({ id: "U1" });
  });

  it("carries enrichment onto the empty fallback record", async () => {
    const { host, queue, adapter } = setup();

    host.handleIncomingMessage(
      adapter,
      "T1",
      baseMessage({ text: "", isMention: true })
    );

    const [record] = await take(queue, 1);
    expect((record?.content as { type: string }).type).toBe("custom");
    expect(record?.isMention).toBe(true);
  });
});

describe("chat-sdk inbound — reactions", () => {
  it("pushes an added reaction as a reaction record", async () => {
    const { host, queue } = setup();

    host.processReaction(
      reactionEvent({
        added: true,
        messageId: "M9",
        rawEmoji: "👍",
        threadId: "T1",
        user: author("U2"),
      })
    );

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("reaction:M9:👍");
    expect(record?.content as { type: string }).toMatchObject({
      type: "reaction",
      action: "add",
    });
    expect(record?.sender).toEqual({ id: "U2" });
    expect(record?.space).toMatchObject({ id: "T1", adapter: "slack" });
  });

  it("forwards a removed reaction with action: remove and a distinct id", async () => {
    const { host, queue } = setup();

    host.processReaction(
      reactionEvent({
        added: false,
        messageId: "M9",
        rawEmoji: "👍",
        threadId: "T1",
        user: author("U2"),
      })
    );

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("reaction:removed:M9:👍");
    expect(record?.content as { type: string }).toMatchObject({
      type: "reaction",
      action: "remove",
    });
  });

  it("drops the bot's own reactions (user.isMe)", async () => {
    const { host, queue } = setup();

    // Self-reaction is skipped...
    host.processReaction(
      reactionEvent({
        added: true,
        messageId: "M9",
        rawEmoji: "👍",
        threadId: "T1",
        user: author("BOT", { isMe: true }),
      })
    );
    // ...so a following real reaction is the first record off the queue.
    host.processReaction(
      reactionEvent({
        added: true,
        messageId: "M9",
        rawEmoji: "🔥",
        threadId: "T1",
        user: author("U2"),
      })
    );

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("reaction:M9:🔥");
  });
});
