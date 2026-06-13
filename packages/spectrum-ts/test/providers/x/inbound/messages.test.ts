import { describe, expect, it } from "bun:test";
import { configSchema } from "@/providers/x/config";
import { handleMessages } from "@/providers/x/inbound/messages";
import type { XPayload } from "@/providers/x/types";

const config = configSchema.parse({
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  xUserId: "42",
  appBearerToken: "app-bearer-token",
});

const legacyPayload = (overrides: Record<string, unknown> = {}) => ({
  for_user_id: "42",
  users: {
    "42": { id: "42", username: "owner", name: "Owner" },
    "99": { id: "99", username: "alice", name: "Alice" },
  },
  direct_message_events: [
    {
      type: "message_create",
      id: "evt-1",
      created_timestamp: "1715800000000",
      message_create: {
        sender_id: "99",
        target: { recipient_id: "42" },
        message_data: { text: "hello from dm" },
      },
      ...overrides,
    },
  ],
});

const activityPayload = {
  data: {
    event_type: "dm.received",
    filter: { user_id: "42" },
    payload: {
      users: {
        "42": { data: { id: "42", username: "owner", name: "Owner" } },
        "99": { data: { id: "99", username: "alice", name: "Alice" } },
      },
      direct_message_events: [
        {
          type: "message_create",
          id: "evt-activity",
          created_timestamp: "1715800005000",
          message_create: {
            sender_id: "99",
            target: { recipient_id: "42" },
            message_data: { text: "from activity api" },
          },
        },
      ],
    },
  },
};

const run = (payload: XPayload) => {
  let reply: {
    body?: string | Uint8Array;
    status?: number;
    headers?: Record<string, string>;
  } = {};
  const result = handleMessages({
    payload,
    config,
    respond: (next) => {
      reply = next;
    },
  } as Parameters<typeof handleMessages>[0]);
  return { result, reply };
};

describe("x inbound handleMessages", () => {
  it("responds to CRC challenges with response_token JSON", () => {
    const { result, reply } = run({ type: "crc", crcToken: "abc123" });
    expect(result).toBeUndefined();
    expect(reply.status).toBe(200);
    expect(reply.headers).toEqual({ "content-type": "application/json" });
    const bodyText =
      typeof reply.body === "string"
        ? reply.body
        : new TextDecoder().decode(reply.body ?? new Uint8Array());
    const json = JSON.parse(bodyText || "{}") as { response_token?: string };
    expect(json.response_token?.startsWith("sha256=")).toBe(true);
  });

  it("maps legacy inbound DMs to provider message records", () => {
    const { result } = run({ type: "dm", body: legacyPayload() });
    expect(result).toMatchObject({
      id: "evt-1",
      direction: "inbound",
      sender: { id: "99", handle: "alice" },
      space: { id: "42:99" },
      content: { type: "text", text: "hello from dm" },
    });
  });

  it("maps Activity API dm.received payloads", () => {
    const { result } = run({ type: "dm", body: activityPayload });
    expect(result).toMatchObject({
      id: "evt-activity",
      sender: { id: "99", handle: "alice" },
      space: { id: "42:99" },
      content: { type: "text", text: "from activity api" },
    });
  });

  it("drops outbound/self echo events", () => {
    const outbound = legacyPayload({
      message_create: {
        sender_id: "42",
        target: { recipient_id: "99" },
        message_data: { text: "my own outbound message" },
      },
    });
    const { result } = run({ type: "dm", body: outbound });
    expect(result).toBeUndefined();
  });

  it("drops events with empty text in v1", () => {
    const emptyText = legacyPayload({
      message_create: {
        sender_id: "99",
        target: { recipient_id: "42" },
        message_data: { text: "   " },
      },
    });
    const { result } = run({ type: "dm", body: emptyText });
    expect(result).toBeUndefined();
  });
});
