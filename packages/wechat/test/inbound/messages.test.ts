import { afterEach, describe, expect, it, vi } from "vitest";
import { remainingPauseMs } from "@/client";
import {
  messages,
  type PollTimings,
  pollMessages,
  toInboundMessage,
} from "@/inbound/messages";
import type { WeChatInboundMessage } from "@/types";
import {
  hang,
  type ILinkHandler,
  inboundText,
  mockILink,
  ok,
  rawJson,
  testClient,
  USER_ID,
} from "../helpers";

const GET_UPDATES = "ilink/bot/getupdates";
const FAST: PollTimings = {
  backoffDelayMs: 1,
  maxConsecutiveFailures: 3,
  retryDelayMs: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run the poll loop until `count` messages arrive, then stop it. */
const collect = async (
  count: number,
  client: Awaited<ReturnType<typeof testClient>>
): Promise<WeChatInboundMessage[]> => {
  const received: WeChatInboundMessage[] = [];
  const controller = new AbortController();
  await pollMessages(
    client,
    (message) => {
      received.push(message);
      if (received.length >= count) {
        controller.abort();
      }
      return Promise.resolve();
    },
    controller.signal,
    FAST
  );
  return received;
};

describe("toInboundMessage", () => {
  it("maps a 1:1 text message and caches its context token", async () => {
    const client = await testClient();

    const message = toInboundMessage(inboundText("hello"), client.state);

    expect(message).toEqual({
      id: "7446744073709551615",
      content: { type: "text", text: "hello" },
      sender: { id: USER_ID },
      space: { id: USER_ID },
      timestamp: new Date(1_762_000_000_000),
    });
    expect(client.state.contextToken(USER_ID)).toBe("ctx-1");
  });

  it("joins several text items into one message", async () => {
    const client = await testClient();
    const message = toInboundMessage(
      inboundText("", {
        item_list: [
          { type: 1, text_item: { text: "line 1" } },
          { type: 2, image_item: {} },
          { type: 1, text_item: { text: "line 2" } },
        ],
      }),
      client.state
    );

    expect(message?.content).toEqual({ type: "text", text: "line 1\nline 2" });
  });

  it("skips media-only messages but still refreshes the context token", async () => {
    const client = await testClient();

    const message = toInboundMessage(
      inboundText("", {
        context_token: "ctx-media",
        item_list: [{ type: 2, image_item: {} }],
      }),
      client.state
    );

    expect(message).toBeUndefined();
    expect(client.state.contextToken(USER_ID)).toBe("ctx-media");
  });

  it("ignores the bot's own messages and group messages", async () => {
    const client = await testClient();

    expect(
      toInboundMessage(inboundText("echo", { message_type: 2 }), client.state)
    ).toBeUndefined();
    expect(
      toInboundMessage(
        inboundText("group", { group_id: "g1", context_token: "ctx-group" }),
        client.state
      )
    ).toBeUndefined();
    expect(client.state.contextToken(USER_ID)).toBeUndefined();
  });

  it("falls back to a sender-scoped id when message_id is missing", async () => {
    const client = await testClient();

    const message = toInboundMessage(
      inboundText("hi", { message_id: undefined, seq: 42 }),
      client.state
    );

    expect(message?.id).toBe(`${USER_ID}:42`);
  });
});

describe("pollMessages", () => {
  it("emits messages and resumes from the returned cursor", async () => {
    const ilink = mockILink({
      [GET_UPDATES]: [
        ok({ msgs: [inboundText("one")], get_updates_buf: "cursor-1" }),
        ok({ msgs: [inboundText("two")], get_updates_buf: "cursor-2" }),
      ],
    });
    const client = await testClient();

    const received = await collect(2, client);

    expect(received.map((m) => m.content)).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
    const cursors = ilink
      .callsTo(GET_UPDATES)
      .map((call) => call.body?.get_updates_buf);
    expect(cursors).toEqual(["", "cursor-1"]);
    expect(client.state.cursor()).toBe("cursor-2");
  });

  it("parses uint64 message ids without losing precision", async () => {
    mockILink({
      [GET_UPDATES]: rawJson(
        `{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"${USER_ID}","message_type":1,"item_list":[{"type":1,"text_item":{"text":"hi"}}]}]}`
      ),
    });

    const [message] = await collect(1, await testClient());

    expect(message?.id).toBe("18446744073709551615");
  });

  it("adopts the server's long-poll timeout", async () => {
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    mockILink({
      [GET_UPDATES]: [
        ok({ longpolling_timeout_ms: 50_000 }),
        ok({ msgs: [inboundText("hi")] }),
      ],
    });

    await collect(1, await testClient());

    // First poll uses the 35 s default, the next the server's value (+5 s grace).
    expect(timeouts).toEqual([40_000, 55_000]);
  });

  it("retries after transport and API errors", async () => {
    const ilink = mockILink({
      [GET_UPDATES]: [
        () => new Response("unavailable", { status: 503 }),
        ok({ ret: -1, errmsg: "busy" }),
        ok({ msgs: [inboundText("finally")] }),
      ],
    });

    const [message] = await collect(1, await testClient());

    expect(message?.content).toEqual({ type: "text", text: "finally" });
    expect(ilink.callsTo(GET_UPDATES)).toHaveLength(3);
  });

  it("treats a client-side long-poll timeout as an empty poll", async () => {
    const timedOut: ILinkHandler = () =>
      Promise.reject(new DOMException("timed out", "TimeoutError"));
    const ilink = mockILink({
      [GET_UPDATES]: [timedOut, ok({ msgs: [inboundText("hi")] })],
    });

    await collect(1, await testClient());

    expect(ilink.callsTo(GET_UPDATES)).toHaveLength(2);
  });

  it("pauses polling after a session-expired response", async () => {
    const ilink = mockILink({ [GET_UPDATES]: ok({ ret: -14 }) });
    const client = await testClient();
    const controller = new AbortController();

    const loop = pollMessages(
      client,
      () => Promise.resolve(),
      controller.signal,
      FAST
    );
    await vi.waitFor(() => expect(remainingPauseMs(client)).toBeGreaterThan(0));
    controller.abort();
    await loop;

    expect(ilink.callsTo(GET_UPDATES)).toHaveLength(1);
  });
});

describe("messages stream", () => {
  it("aborts the in-flight long-poll when closed", async () => {
    const ilink = mockILink({
      [GET_UPDATES]: [ok({ msgs: [inboundText("hi")] }), hang],
    });
    const client = await testClient();
    const stream = messages({ client });
    const iterator = stream[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.content).toEqual({ type: "text", text: "hi" });
    // The stream is backpressured: asking for the next message lets the loop
    // start its next (idle) long-poll.
    const second = iterator.next();
    await vi.waitFor(() => expect(ilink.callsTo(GET_UPDATES)).toHaveLength(2));

    await stream.close();

    expect(ilink.callsTo(GET_UPDATES)[1]?.signal?.aborted).toBe(true);
    await expect(second).resolves.toMatchObject({ done: true });
  });
});
