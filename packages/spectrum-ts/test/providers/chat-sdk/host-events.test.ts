import { describe, expect, it } from "bun:test";
import { chatHostEvent } from "@/providers/chat-sdk";
import { SpectrumChatHost } from "@/providers/chat-sdk/host";
import { makeEventQueue } from "@/providers/chat-sdk/queue";
import type {
  ChatAdapter,
  ChatInboundMessage,
  ChatThread,
} from "@/providers/chat-sdk/types";
import type { Message } from "@/types/message";
import { author, noopLogger } from "./_fixtures";

const makeAdapter = (name = "slack"): ChatAdapter =>
  ({
    name,
    initialize: () => Promise.resolve(),
    channelIdFromThreadId: (id: string) => `chan:${id}`,
    handleWebhook: () => Promise.resolve(new Response()),
    addReaction: () => Promise.resolve(),
  }) as unknown as ChatAdapter;

const setup = () => {
  const queue = makeEventQueue<ChatInboundMessage>();
  const adapter = makeAdapter();
  const host = new SpectrumChatHost({
    adapter,
    userName: "bot",
    state: {},
    logger: noopLogger,
    queue,
    threads: new Map<string, ChatThread>(),
    makeThread: () => ({}) as ChatThread,
  });
  return { host, queue, adapter };
};

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

// Read a surfaced record back through the public `chatHostEvent` helper, which
// takes a Spectrum `Message` — the inbound record is structurally one.
const asMessage = (record: ChatInboundMessage): Message =>
  record as unknown as Message;

describe("chat-sdk host events — actions", () => {
  it("surfaces a button click as a custom action record", async () => {
    const { host, adapter, queue } = setup();

    host.processAction({
      adapter,
      actionId: "approve",
      messageId: "M9",
      threadId: "T1",
      user: author("U2"),
      value: "yes",
      raw: { native: true },
    });

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("action:M9:approve");
    expect(record?.sender).toEqual({ id: "U2" });
    expect(record?.space).toMatchObject({ id: "T1", adapter: "slack" });

    const event = chatHostEvent(asMessage(record as ChatInboundMessage));
    expect(event).toEqual({
      chatsdk_type: "action",
      actionId: "approve",
      messageId: "M9",
      value: "yes",
      raw: { native: true },
    });
  });

  it("drops the bot's own action (user.isMe)", async () => {
    const { host, adapter, queue } = setup();

    host.processAction({
      adapter,
      actionId: "noop",
      messageId: "M9",
      threadId: "T1",
      user: author("BOT", { isMe: true }),
      raw: {},
    });
    host.processAction({
      adapter,
      actionId: "real",
      messageId: "M9",
      threadId: "T1",
      user: author("U2"),
      raw: {},
    });

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("action:M9:real");
  });

  it("stamps the event's adapter name onto the space", async () => {
    const { host, queue } = setup();

    // The event carries its own adapter; the space reflects it.
    host.processAction({
      adapter: makeAdapter("discord"),
      actionId: "a",
      messageId: "M1",
      threadId: "T1",
      user: author("U2"),
      raw: {},
    });

    const [record] = await take(queue, 1);
    expect(record?.space.adapter).toBe("discord");
  });
});

describe("chat-sdk host events — slash commands", () => {
  it("surfaces a slash command with command + args text", async () => {
    const { host, adapter, queue } = setup();

    host.processSlashCommand({
      adapter,
      channelId: "C1",
      command: "/help",
      text: "topic search",
      triggerId: "trig",
      user: author("U2"),
      raw: { native: true },
    });

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("slash:C1:/help");
    expect(record?.space).toMatchObject({ id: "C1", adapter: "slack" });

    const event = chatHostEvent(asMessage(record as ChatInboundMessage));
    expect(event).toMatchObject({
      chatsdk_type: "slash-command",
      command: "/help",
      text: "topic search",
      triggerId: "trig",
    });
  });
});

describe("chat-sdk host events — modals", () => {
  it("surfaces a modal submit with its field values and resolves undefined", async () => {
    const { host, adapter, queue } = setup();

    const result = await host.processModalSubmit({
      adapter,
      callbackId: "feedback_modal",
      viewId: "V1",
      values: { feedback: "great" },
      privateMetadata: "ctx",
      user: author("U2"),
      raw: {},
    });
    // The adapter awaits a ModalResponse | undefined — we accept (undefined).
    expect(result).toBeUndefined();

    const [record] = await take(queue, 1);
    expect(record?.id).toBe("modal-submit:V1");
    const event = chatHostEvent(asMessage(record as ChatInboundMessage));
    expect(event).toMatchObject({
      chatsdk_type: "modal-submit",
      callbackId: "feedback_modal",
      viewId: "V1",
      values: { feedback: "great" },
      privateMetadata: "ctx",
    });
  });

  it("surfaces a modal close", async () => {
    const { host, adapter, queue } = setup();

    host.processModalClose({
      adapter,
      callbackId: "feedback_modal",
      viewId: "V1",
      user: author("U2"),
      raw: {},
    });

    const [record] = await take(queue, 1);
    const event = chatHostEvent(asMessage(record as ChatInboundMessage));
    expect(event?.chatsdk_type).toBe("modal-close");
  });
});

describe("chat-sdk host events — options load", () => {
  it("surfaces a dynamic-select query and resolves undefined", async () => {
    const { host, adapter, queue } = setup();

    const result = await host.processOptionsLoad({
      adapter,
      actionId: "country",
      query: "ire",
      user: author("U2"),
      raw: {},
    });
    expect(result).toBeUndefined();

    const [record] = await take(queue, 1);
    const event = chatHostEvent(asMessage(record as ChatInboundMessage));
    expect(event).toMatchObject({
      chatsdk_type: "options-load",
      actionId: "country",
      query: "ire",
    });
  });
});

describe("chat-sdk host events — lifecycle", () => {
  it("surfaces app-home opens, assistant events, and member joins", async () => {
    const { host, adapter, queue } = setup();

    host.processAppHomeOpened({ adapter, channelId: "C1", userId: "U2" });
    host.processAssistantThreadStarted({
      adapter,
      channelId: "C1",
      threadId: "T1",
      threadTs: "ts",
      userId: "U2",
      context: { teamId: "team" },
    });
    host.processAssistantContextChanged({
      adapter,
      channelId: "C1",
      threadId: "T1",
      threadTs: "ts",
      userId: "U2",
      context: {},
    });
    host.processMemberJoinedChannel({
      adapter,
      channelId: "C1",
      userId: "U2",
      inviterId: "U1",
    });

    const records = await take(queue, 4);
    const types = records.map((r) => chatHostEvent(asMessage(r))?.chatsdk_type);
    expect(types).toEqual([
      "app-home-opened",
      "assistant-thread-started",
      "assistant-context-changed",
      "member-joined-channel",
    ]);

    const join = chatHostEvent(asMessage(records[3] as ChatInboundMessage));
    expect(join).toEqual({
      chatsdk_type: "member-joined-channel",
      inviterId: "U1",
    });
    expect(records[3]?.sender).toEqual({ id: "U2" });
  });
});

describe("chatHostEvent reader", () => {
  it("returns undefined for a plain text message", () => {
    const message = {
      content: { type: "text", text: "hi" },
    } as unknown as Message;
    expect(chatHostEvent(message)).toBeUndefined();
  });

  it("returns undefined for unrelated custom content", () => {
    const message = {
      content: { type: "custom", raw: { chatsdk_type: "empty" } },
    } as unknown as Message;
    expect(chatHostEvent(message)).toBeUndefined();
  });
});
