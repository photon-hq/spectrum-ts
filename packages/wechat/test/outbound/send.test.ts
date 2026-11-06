import { type Content, UnsupportedError } from "@spectrum-ts/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WeChatApiError,
  WeChatContextTokenError,
  WeChatSessionPausedError,
} from "@/errors";
import { send } from "@/outbound/send";
import { mockILink, ok, testClient, USER_ID } from "../helpers";

const SEND = "ilink/bot/sendmessage";
const GET_CONFIG = "ilink/bot/getconfig";
const SEND_TYPING = "ilink/bot/sendtyping";
const CLIENT_ID = /^spectrum-wechat:/;

const space = { id: USER_ID };
const text = (value: string): Content => ({ type: "text", text: value });
const typing = (state: "start" | "stop"): Content => ({
  type: "typing",
  state,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("send text", () => {
  it("echoes the cached context token and returns the server id", async () => {
    const ilink = mockILink({ [SEND]: ok({ message_id: "991" }) });
    const client = await testClient({ [USER_ID]: "ctx-1" });

    const record = await send({ client, content: text("hi"), space });

    const msg = ilink.callsTo(SEND)[0]?.body?.msg as Record<string, unknown>;
    expect(msg).toMatchObject({
      from_user_id: "",
      to_user_id: USER_ID,
      message_type: 2,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "hi" } }],
    });
    expect(msg.client_id).toMatch(CLIENT_ID);
    expect(record).toMatchObject({
      id: "991",
      content: text("hi"),
      space: { id: USER_ID },
    });
  });

  it("falls back to its own client id when the server returns none", async () => {
    const ilink = mockILink({ [SEND]: ok() });
    const client = await testClient({ [USER_ID]: "ctx-1" });

    const record = await send({ client, content: text("hi"), space });

    const msg = ilink.callsTo(SEND)[0]?.body?.msg as { client_id: string };
    expect(record?.id).toBe(msg.client_id);
  });

  it("still tries without a context token and succeeds if iLink allows it", async () => {
    const ilink = mockILink({ [SEND]: ok() });
    const client = await testClient();

    await expect(
      send({ client, content: text("hi"), space })
    ).resolves.toBeDefined();
    const msg = ilink.callsTo(SEND)[0]?.body?.msg as Record<string, unknown>;
    expect(msg).not.toHaveProperty("context_token");
  });

  it("raises WeChatContextTokenError when a token-less send is rejected", async () => {
    mockILink({ [SEND]: ok({ ret: -2, errmsg: "invalid context" }) });
    const client = await testClient();

    const error = await send({ client, content: text("hi"), space }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(WeChatContextTokenError);
    expect(error).toMatchObject({ userId: USER_ID });
    expect((error as Error).cause).toBeInstanceOf(WeChatApiError);
  });

  it("keeps WeChatApiError when the send carried a token", async () => {
    mockILink({ [SEND]: ok({ ret: -2 }) });
    const client = await testClient({ [USER_ID]: "ctx-1" });

    await expect(
      send({ client, content: text("hi"), space })
    ).rejects.toBeInstanceOf(WeChatApiError);
  });

  it("does not blame the token for HTTP failures", async () => {
    mockILink({ [SEND]: () => new Response("", { status: 500 }) });
    const client = await testClient();

    await expect(
      send({ client, content: text("hi"), space })
    ).rejects.toMatchObject({ name: "WeChatApiError", status: 500 });
  });

  it("pauses the session on -14 and then fails fast without calling iLink", async () => {
    const ilink = mockILink({ [SEND]: ok({ ret: -14 }) });
    const client = await testClient({ [USER_ID]: "ctx-1" });

    await expect(
      send({ client, content: text("one"), space })
    ).rejects.toMatchObject({ sessionExpired: true });
    await expect(
      send({ client, content: text("two"), space })
    ).rejects.toBeInstanceOf(WeChatSessionPausedError);
    expect(ilink.callsTo(SEND)).toHaveLength(1);
  });
});

describe("send typing", () => {
  it("fetches a typing ticket once and toggles typing on and off", async () => {
    const ilink = mockILink({
      [GET_CONFIG]: ok({ typing_ticket: "ticket-1" }),
      [SEND_TYPING]: ok(),
    });
    const client = await testClient({ [USER_ID]: "ctx-1" });

    await expect(
      send({ client, content: typing("start"), space })
    ).resolves.toBeUndefined();
    await send({ client, content: typing("stop"), space });

    expect(ilink.callsTo(GET_CONFIG)).toHaveLength(1);
    expect(ilink.callsTo(GET_CONFIG)[0]?.body).toMatchObject({
      ilink_user_id: USER_ID,
      context_token: "ctx-1",
    });
    expect(ilink.callsTo(SEND_TYPING).map((call) => call.body)).toMatchObject([
      { ilink_user_id: USER_ID, typing_ticket: "ticket-1", status: 1 },
      { ilink_user_id: USER_ID, typing_ticket: "ticket-1", status: 2 },
    ]);
  });

  it("skips typing when iLink grants no ticket", async () => {
    const ilink = mockILink({ [GET_CONFIG]: ok(), [SEND_TYPING]: ok() });
    const client = await testClient();

    await send({ client, content: typing("start"), space });

    expect(ilink.callsTo(SEND_TYPING)).toHaveLength(0);
  });

  it("swallows typing failures", async () => {
    mockILink({ [GET_CONFIG]: () => new Response("", { status: 500 }) });
    const client = await testClient();

    await expect(
      send({ client, content: typing("start"), space })
    ).resolves.toBeUndefined();
  });
});

describe("unsupported content", () => {
  it("throws UnsupportedError so core can fall back or warn", async () => {
    const client = await testClient();

    await expect(
      send({
        client,
        content: { type: "markdown", markdown: "**hi**" } as Content,
        space,
      })
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});
