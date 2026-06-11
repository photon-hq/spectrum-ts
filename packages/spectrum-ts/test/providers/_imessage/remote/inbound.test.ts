import { describe, expect, it } from "bun:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { MessageCache } from "@/providers/imessage/cache";
import {
  type AppleMessage,
  type ReceivedEvent,
  rebuildFromAppleMessage,
  toInboundMessages,
} from "@/providers/imessage/remote/inbound";
import type { IMessageMessage } from "@/providers/imessage/types";

const SENT_DATE = new Date(1_700_000_000_000);
const CHAT_GUID = "any;-;+15550100";
const PHONE = "+15550123";
// Apple stores attachment placeholders in message text as U+FFFC.
const ATTACHMENT_PLACEHOLDER = "\uFFFC";

type AppleAttachment = AppleMessage["content"]["attachments"][number];

const client = {} as AdvancedIMessage;

const attachment = (
  guid: string,
  fileName: string,
  mimeType = "image/jpeg"
): AppleAttachment =>
  ({
    guid,
    fileName,
    mimeType,
    totalBytes: 123,
  }) as AppleAttachment;

const appleMessage = (input: {
  attachments?: AppleAttachment[];
  guid?: string;
  text?: string;
}): AppleMessage =>
  ({
    guid: input.guid ?? "msg-guid",
    dateCreated: SENT_DATE,
    sender: { address: "+15550999" },
    chatGuids: [CHAT_GUID],
    content: {
      attachments: input.attachments ?? [],
      text: input.text,
    },
  }) as unknown as AppleMessage;

const receivedEvent = (message: AppleMessage): ReceivedEvent =>
  ({
    type: "message.received",
    chatGuid: CHAT_GUID,
    message,
    occurredAt: SENT_DATE,
  }) as unknown as ReceivedEvent;

const groupItems = (message: IMessageMessage): IMessageMessage[] => {
  if (message.content.type !== "group") {
    throw new Error("expected group content");
  }
  return message.content.items as unknown as IMessageMessage[];
};

describe("iMessage remote inbound", () => {
  it("keeps a bare single attachment as attachment content", async () => {
    const message = await rebuildFromAppleMessage(
      client,
      appleMessage({
        attachments: [attachment("att-1", "photo.jpg")],
        text: ATTACHMENT_PLACEHOLDER,
      }),
      PHONE
    );

    expect(message.id).toBe("msg-guid");
    expect(message.partIndex).toBe(0);
    expect(message.parentId).toBeUndefined();
    expect(message.content).toMatchObject({
      type: "attachment",
      id: "att-1",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: 123,
    });
  });

  it("groups caption text with a single attachment", async () => {
    const message = await rebuildFromAppleMessage(
      client,
      appleMessage({
        attachments: [attachment("att-1", "photo.jpg")],
        text: `${ATTACHMENT_PLACEHOLDER}Look at this`,
      }),
      PHONE
    );

    const items = groupItems(message);
    expect(message.id).toBe("msg-guid");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "p:0/msg-guid",
      parentId: "msg-guid",
      partIndex: 0,
      content: { type: "text", text: "Look at this" },
    });
    expect(items[1]).toMatchObject({
      id: "p:1/msg-guid",
      parentId: "msg-guid",
      partIndex: 1,
      content: {
        type: "attachment",
        id: "att-1",
        name: "photo.jpg",
      },
    });
  });

  it("preserves native part order for caption plus multiple attachments", async () => {
    const message = await rebuildFromAppleMessage(
      client,
      appleMessage({
        attachments: [
          attachment("att-1", "photo-1.jpg"),
          attachment("att-2", "photo-2.jpg"),
        ],
        text: `${ATTACHMENT_PLACEHOLDER}${ATTACHMENT_PLACEHOLDER}Two photos`,
      }),
      PHONE
    );

    const items = groupItems(message);
    expect(items.map((item) => item.id)).toEqual([
      "p:0/msg-guid",
      "p:1/msg-guid",
      "p:2/msg-guid",
    ]);
    expect(items.map((item) => item.partIndex)).toEqual([0, 1, 2]);
    expect(items.map((item) => item.parentId)).toEqual([
      "msg-guid",
      "msg-guid",
      "msg-guid",
    ]);
    expect(items[0]?.content).toEqual({ type: "text", text: "Two photos" });
  });

  it("does not create text items for attachment placeholders only", async () => {
    const message = await rebuildFromAppleMessage(
      client,
      appleMessage({
        attachments: [
          attachment("att-1", "photo-1.jpg"),
          attachment("att-2", "photo-2.jpg"),
        ],
        text: `${ATTACHMENT_PLACEHOLDER}${ATTACHMENT_PLACEHOLDER}`,
      }),
      PHONE
    );

    const items = groupItems(message);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.partIndex)).toEqual([0, 1]);
    expect(items.map((item) => item.content.type)).toEqual([
      "attachment",
      "attachment",
    ]);
  });

  it("caches grouped caption and attachment children from inbound events", async () => {
    const cache = new MessageCache();
    const [message] = await toInboundMessages(
      client,
      cache,
      receivedEvent(
        appleMessage({
          attachments: [attachment("att-1", "photo.jpg")],
          text: "Caption",
        })
      ),
      PHONE
    );

    expect(message?.content.type).toBe("group");
    expect(cache.get("msg-guid")?.content.type).toBe("group");
    expect(cache.get("p:0/msg-guid")?.content).toEqual({
      type: "text",
      text: "Caption",
    });
    expect(cache.get("p:1/msg-guid")?.content).toMatchObject({
      type: "attachment",
      id: "att-1",
    });
  });
});
