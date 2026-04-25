import { describe, expect, test } from "bun:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { MessageCache } from "../cache";
import type { IMessageMessage } from "../types";
import { type ReceivedEvent, toInboundMessages } from "./inbound";

const createRemote = (): AdvancedIMessage =>
  ({
    attachments: {
      download: () => ({ stream: new ReadableStream<Uint8Array>() }),
      downloadBuffer: async () => Buffer.alloc(0),
    },
  }) as unknown as AdvancedIMessage;

describe("remote iMessage inbound conversion", () => {
  test("converts multi-attachment messages into an addressable group", async () => {
    const timestamp = new Date("2026-01-01T00:00:00Z");
    const cache = new MessageCache();
    const event = {
      chatGuid: "chat;+;group",
      message: {
        attachments: [
          {
            fileName: "one.png",
            guid: "attachment-one",
            mimeType: "image/png",
            totalBytes: 1,
          },
          {
            fileName: "two.png",
            guid: "attachment-two",
            mimeType: "image/png",
            totalBytes: 2,
          },
        ],
        chatGuids: ["chat;+;group"],
        dateCreated: timestamp,
        guid: "parent-guid",
        isFromMe: false,
        sender: { address: "sender-id" },
        text: undefined,
      },
      timestamp,
      type: "message.received",
    } as unknown as ReceivedEvent;

    const [parent] = await toInboundMessages(createRemote(), cache, event);

    expect(parent?.id).toBe("parent-guid");
    expect(parent?.content.type).toBe("group");
    if (parent?.content.type !== "group") {
      throw new Error("Expected group content");
    }

    const items = parent.content.items as unknown as IMessageMessage[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "p:0/parent-guid",
      parentId: "parent-guid",
      partIndex: 0,
    });
    expect(items[1]).toMatchObject({
      id: "p:1/parent-guid",
      parentId: "parent-guid",
      partIndex: 1,
    });
    expect(cache.get("parent-guid")).toBe(parent);
    expect(cache.get("p:0/parent-guid")).toBe(items[0]);
  });
});
