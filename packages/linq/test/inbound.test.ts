import { describe, expect, it } from "bun:test";
import { handleMessages } from "../src/inbound/messages";
import type { LinqPayload } from "../src/types";

const handle = (id: string, phone: string) => ({
  id,
  handle: phone,
  joined_at: "2026-05-29T00:00:00Z",
  service: "iMessage" as const,
  is_me: false,
});

const event = (eventType: string, data: unknown): LinqPayload =>
  ({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: eventType,
    event_id: "evt-1",
    created_at: "2026-05-29T00:00:00Z",
    trace_id: "t",
    partner_id: "p",
    data,
  }) as unknown as LinqPayload;

const messageData = (parts: unknown[]) => ({
  id: "m1",
  chat: { id: "c1" },
  direction: "inbound",
  parts,
  sender_handle: handle("u1", "+15551112222"),
  service: "iMessage",
  sent_at: "2026-05-29T00:00:01Z",
});

describe("handleMessages — message.received", () => {
  it("maps a single text part to text content", () => {
    const record = handleMessages({
      payload: event(
        "message.received",
        messageData([{ type: "text", value: "hello" }])
      ),
    });
    expect(record?.id).toBe("m1");
    expect(record?.content).toEqual({ type: "text", text: "hello" });
    expect(record?.sender?.id).toBe("u1");
    expect(record?.space.id).toBe("c1");
    expect(record?.timestamp).toEqual(new Date("2026-05-29T00:00:01Z"));
  });

  it("maps an image media part to a lazy attachment", () => {
    const record = handleMessages({
      payload: event(
        "message.received",
        messageData([
          {
            type: "media",
            id: "att1",
            filename: "photo.jpg",
            mime_type: "image/jpeg",
            size_bytes: 1234,
            url: "https://cdn.linqapp.test/photo.jpg",
          },
        ])
      ),
    });
    expect(record?.content.type).toBe("attachment");
    if (record?.content.type === "attachment") {
      expect(record.content.name).toBe("photo.jpg");
      expect(record.content.mimeType).toBe("image/jpeg");
      expect(record.content.size).toBe(1234);
    }
  });

  it("maps an audio media part to voice content", () => {
    const record = handleMessages({
      payload: event(
        "message.received",
        messageData([
          {
            type: "media",
            id: "att2",
            filename: "memo.m4a",
            mime_type: "audio/x-m4a",
            size_bytes: 999,
            url: "https://cdn.linqapp.test/memo.m4a",
          },
        ])
      ),
    });
    expect(record?.content.type).toBe("voice");
  });

  it("bundles multiple parts into a group", () => {
    const record = handleMessages({
      payload: event(
        "message.received",
        messageData([
          { type: "text", value: "see this" },
          {
            type: "media",
            id: "att3",
            filename: "p.png",
            mime_type: "image/png",
            size_bytes: 10,
            url: "https://cdn.linqapp.test/p.png",
          },
        ])
      ),
    });
    expect(record?.content.type).toBe("group");
    if (record?.content.type === "group") {
      expect(record.content.items).toHaveLength(2);
    }
  });

  it("ignores a message with no parts", () => {
    const record = handleMessages({
      payload: event("message.received", messageData([])),
    });
    expect(record).toBeUndefined();
  });
});

describe("handleMessages — reactions", () => {
  it("maps a love tapback to a reaction targeting the message", () => {
    const record = handleMessages({
      payload: event("reaction.added", {
        is_from_me: false,
        reaction_type: "love",
        chat_id: "c1",
        message_id: "m1",
        from_handle: handle("u2", "+15553334444"),
        reacted_at: "2026-05-29T00:00:02Z",
      }),
    });
    expect(record?.content.type).toBe("reaction");
    if (record?.content.type === "reaction") {
      expect(record.content.emoji).toBe("❤️");
      expect(record.content.target.id).toBe("m1");
    }
    expect(record?.space.id).toBe("c1");
  });

  it("maps a custom emoji reaction", () => {
    const record = handleMessages({
      payload: event("reaction.added", {
        is_from_me: false,
        reaction_type: "custom",
        custom_emoji: "🎉",
        chat_id: "c1",
        message_id: "m1",
      }),
    });
    expect(record?.content.type).toBe("reaction");
    if (record?.content.type === "reaction") {
      expect(record.content.emoji).toBe("🎉");
    }
  });

  it("ignores sticker reactions (not representable as an emoji)", () => {
    const record = handleMessages({
      payload: event("reaction.added", {
        is_from_me: false,
        reaction_type: "sticker",
        chat_id: "c1",
        message_id: "m1",
      }),
    });
    expect(record).toBeUndefined();
  });
});

describe("handleMessages — typing & ignored events", () => {
  it("maps typing started/stopped to typing content", () => {
    const started = handleMessages({
      payload: event("chat.typing_indicator.started", { chat_id: "c1" }),
    });
    expect(started?.content).toEqual({ type: "typing", state: "start" });

    const stopped = handleMessages({
      payload: event("chat.typing_indicator.stopped", { chat_id: "c1" }),
    });
    expect(stopped?.content).toEqual({ type: "typing", state: "stop" });
  });

  it("ignores our own sends and status events", () => {
    for (const type of [
      "message.sent",
      "message.delivered",
      "message.read",
      "message.failed",
      "message.edited",
      "reaction.removed",
      "participant.added",
      "chat.group_name_updated",
    ]) {
      expect(
        handleMessages({ payload: event(type, { chat_id: "c1" }) })
      ).toBeUndefined();
    }
  });
});
