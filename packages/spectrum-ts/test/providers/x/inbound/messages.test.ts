import { describe, expect, it, mock, spyOn } from "bun:test";
import { createCloudAuth } from "@/providers/x/auth";
import { directConfigSchema } from "@/providers/x/config";
import { handleMessages } from "@/providers/x/inbound/messages";
import type { XPayload } from "@/providers/x/types";
import { cloud } from "@/utils/cloud";
import { createStore } from "@/utils/store";

const config = directConfigSchema.parse({
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  xUserId: "42",
  appBearerToken: "app-bearer-token",
});

const store = createStore();

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

// Real chat.received payload: flat structure, no direct_message_events, text is
// binary-encoded in encoded_event and cannot be decoded.
const chatReceivedPayload = {
  data: {
    event_type: "chat.received",
    filter: { user_id: "42" },
    payload: {
      id: "evt-chat-uuid",
      created_at_msec: "1715800010000",
      sender_id: "99",
      conversation_id: "42:99",
      encoded_event: "base64binaryblob==",
    },
  },
};

const run = async (payload: XPayload) => {
  let reply: {
    body?: string | Uint8Array;
    status?: number;
    headers?: Record<string, string>;
  } = {};
  const result = await handleMessages({
    payload,
    config,
    store,
    respond: (next) => {
      reply = next;
    },
  } as Parameters<typeof handleMessages>[0]);
  return { result, reply };
};

describe("x inbound handleMessages", () => {
  it("responds to CRC challenges with response_token JSON", async () => {
    const { result, reply } = await run({ type: "crc", crcToken: "abc123" });
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

  it("maps legacy inbound DMs to provider message records", async () => {
    const { result } = await run({ type: "dm", body: legacyPayload() });
    expect(result).toMatchObject({
      id: "evt-1",
      direction: "inbound",
      sender: { id: "99", handle: "alice" },
      space: { id: "42:99" },
      content: { type: "text", text: "hello from dm" },
    });
  });

  it("maps Activity API dm.received payloads", async () => {
    const { result } = await run({ type: "dm", body: activityPayload });
    expect(result).toMatchObject({
      id: "evt-activity",
      sender: { id: "99", handle: "alice" },
      space: { id: "42:99" },
      content: { type: "text", text: "from activity api" },
    });
  });

  it("maps Activity API chat.received payloads (no decodable text)", async () => {
    const { result } = await run({ type: "dm", body: chatReceivedPayload });
    expect(result).toMatchObject({
      id: "evt-chat-uuid",
      direction: "inbound",
      sender: { id: "99" },
      space: { id: "42:99" },
      content: { type: "custom", raw: { encodedEvent: "base64binaryblob==" } },
    });
  });

  it("drops outbound/self echo events", async () => {
    const outbound = legacyPayload({
      message_create: {
        sender_id: "42",
        target: { recipient_id: "99" },
        message_data: { text: "my own outbound message" },
      },
    });
    const { result } = await run({ type: "dm", body: outbound });
    expect(result).toBeUndefined();
  });

  it("drops legacy DM events with empty text", async () => {
    const emptyText = legacyPayload({
      message_create: {
        sender_id: "99",
        target: { recipient_id: "42" },
        message_data: { text: "   " },
      },
    });
    const { result } = await run({ type: "dm", body: emptyText });
    expect(result).toBeUndefined();
  });

  it("responds to CRC challenges using cloud credentials", async () => {
    spyOn(cloud, "issueXCredentials").mockResolvedValue({
      auth: { "42": "cloud-access-token" },
      accounts: { a: { xUserId: "42" } },
      consumerSecret: "cloud-consumer-secret",
      expiresIn: 900,
    });

    const cloudStore = createStore();
    await createCloudAuth({
      projectId: "proj",
      projectSecret: "secret",
      store: cloudStore,
    });

    let reply: {
      body?: string | Uint8Array;
      status?: number;
      headers?: Record<string, string>;
    } = {};
    const result = await handleMessages({
      payload: { type: "crc", crcToken: "cloud-crc-token" },
      config: {},
      store: cloudStore,
      respond: (next) => {
        reply = next;
      },
    } as Parameters<typeof handleMessages>[0]);

    expect(result).toBeUndefined();
    expect(reply.status).toBe(200);
    const bodyText =
      typeof reply.body === "string"
        ? reply.body
        : new TextDecoder().decode(reply.body ?? new Uint8Array());
    const json = JSON.parse(bodyText || "{}") as { response_token?: string };
    expect(json.response_token?.startsWith("sha256=")).toBe(true);

    mock.restore();
  });
});
