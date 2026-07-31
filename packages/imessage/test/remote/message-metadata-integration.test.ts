import type {
  AdvancedIMessage,
  MessageEvent,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage/http";
import type { Content, Message } from "@spectrum-ts/core";
import { asAttachment, asGroup, asText } from "@spectrum-ts/core/authoring";
import { describe, expect, it, vi } from "vitest";
import { MessageCache } from "@/cache";
import {
  getMessage,
  type ReceivedEvent,
  toInboundMessages,
} from "@/remote/inbound";
import { send } from "@/remote/send";
import type { IMessageMessage } from "@/types";

const CREATED_AT = new Date("2026-02-03T04:05:06.000Z");
const DELIVERED_AT = new Date("2026-02-03T04:05:07.000Z");
const READ_AT = new Date("2026-02-03T04:05:08.000Z");
const ATTACHMENT_PLACEHOLDER = "\uFFFC";

const nativeAttachment = (
  guid = "attachment-guid"
): SDKMessage["content"]["attachments"][number] => ({
  fileName: "photo.png",
  guid,
  isHidden: false,
  isOutgoing: false,
  isSticker: false,
  mimeType: "image/png",
  totalBytes: 256,
  transferState: "transferring",
  uti: "public.png",
});

const nativeMessage = (overrides: Partial<SDKMessage> = {}): SDKMessage => ({
  appliedReactions: [],
  chatGuids: ["iMessage;+;chat-guid"],
  content: {
    attachments: [],
    formatting: [{ length: 5, start: 0, type: "bold" }],
    mentions: [{ address: "+15551230002", length: 7, start: 6 }],
    text: "Hello @Taylor",
  },
  dataDetectorResultsPresent: false,
  dateCreated: CREATED_AT,
  dateDelivered: DELIVERED_AT,
  dateRead: READ_AT,
  didNotifyRecipient: true,
  guid: "message-guid",
  isArchived: false,
  isAudioMessage: false,
  isAutoReply: false,
  isCorrupt: false,
  isDelayed: false,
  isDelivered: true,
  isDeliveredQuietly: false,
  isExpirable: false,
  isForward: false,
  isFromMe: false,
  isSent: true,
  isServiceMessage: false,
  isSpam: false,
  isSystemMessage: false,
  itemType: "normal",
  placedStickers: [],
  sendErrorCode: 0,
  sender: {
    address: "+15551230001",
    country: "US",
    service: "iMessage",
  },
  ...overrides,
});

const receivedEvent = (message: SDKMessage): ReceivedEvent =>
  ({
    chatGuid: "iMessage;+;chat-guid",
    isFromMe: message.isFromMe,
    message,
    occurredAt: CREATED_AT,
    sequence: 1,
    type: "message.received",
  }) as Extract<MessageEvent, { type: "message.received" }>;

const groupOf = (...contents: Content[]): Content =>
  asGroup({
    items: contents.map(
      (content) => ({ content, id: "" }) as unknown as Message
    ),
  });

describe("curated metadata across native message paths", () => {
  it("includes metadata on ordinary inbound messages without extra RPCs", async () => {
    const get = vi.fn();
    const remote = { messages: { get } } as unknown as AdvancedIMessage;

    const [message] = await toInboundMessages(
      remote,
      new MessageCache(),
      receivedEvent(nativeMessage()),
      "+15550000000"
    );

    expect(get).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      dateDelivered: DELIVERED_AT,
      dateRead: READ_AT,
      formatting: [{ length: 5, start: 0, type: "bold" }],
      isDelivered: true,
      mentions: [{ address: "+15551230002", length: 7, start: 6 }],
      nativeText: "Hello @Taylor",
      sendErrorCode: 0,
    });
  });

  it("includes metadata on getMessage and preserves cache-first behavior", async () => {
    const get = vi.fn(() => Promise.resolve(nativeMessage()));
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;

    const first = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "message-guid",
      "+15550000000"
    );
    const second = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "message-guid",
      "+15550000000"
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(first?.dateDelivered).toEqual(DELIVERED_AT);
    expect(first?.nativeText).toBe("Hello @Taylor");
    expect(second).toBe(first);
  });

  it("computes multipart metadata once and carries it to every child", async () => {
    const attachment = nativeAttachment();
    const [parent] = await toInboundMessages(
      { messages: {} } as unknown as AdvancedIMessage,
      new MessageCache(),
      receivedEvent(
        nativeMessage({
          content: {
            attachments: [attachment],
            formatting: [],
            mentions: [],
            text: `before ${ATTACHMENT_PLACEHOLDER} after`,
          },
          partCount: 3,
        })
      ),
      "+15550000000"
    );

    expect(parent?.content.type).toBe("group");
    if (parent?.content.type !== "group") {
      throw new Error("expected multipart group");
    }

    expect(parent.partCount).toBe(3);
    expect(parent.attachmentMetadata).toEqual([
      {
        companionKind: undefined,
        fileName: "photo.png",
        guid: "attachment-guid",
        isHidden: false,
        isSticker: false,
        mimeType: "image/png",
        originalGuid: undefined,
        totalBytes: 256,
        transferState: "transferring",
        uti: "public.png",
      },
    ]);
    for (const [partIndex, item] of parent.content.items.entries()) {
      const child = item as unknown as IMessageMessage;
      expect(child.parentId).toBe("message-guid");
      expect(child.partIndex).toBe(partIndex);
      expect(child.attachmentMetadata).toEqual(parent.attachmentMetadata);
    }
  });

  it("includes metadata on native regular and multipart outbound results", async () => {
    const singleNative = nativeMessage({
      guid: "single-guid",
      isFromMe: true,
    });
    const multipartNative = nativeMessage({
      content: {
        attachments: [nativeAttachment()],
        formatting: [],
        mentions: [],
        text: `hello ${ATTACHMENT_PLACEHOLDER}`,
      },
      guid: "multipart-guid",
      isFromMe: true,
      partCount: 2,
    });
    const sendText = vi.fn(() => Promise.resolve(singleNative));
    const sendMultipart = vi.fn(() => Promise.resolve(multipartNative));
    const upload = vi.fn(() =>
      Promise.resolve({ attachment: { guid: "uploaded-guid" } })
    );
    const remote = {
      attachments: { upload },
      messages: { sendMultipart, sendText },
    } as unknown as AdvancedIMessage;
    const attachment = asAttachment({
      mimeType: "image/png",
      name: "photo.png",
      read: () => Promise.resolve(Buffer.from("photo")),
    });

    const single = (await send(
      remote,
      "iMessage;+;chat-guid",
      asText("Hello")
    )) as IMessageMessage;
    const multipart = (await send(
      remote,
      "iMessage;+;chat-guid",
      groupOf(asText("hello"), attachment)
    )) as IMessageMessage;

    expect(single).toMatchObject({
      dateDelivered: DELIVERED_AT,
      isDelivered: true,
      nativeText: "Hello @Taylor",
      sendErrorCode: 0,
    });
    expect(multipart.partCount).toBe(2);
    expect(multipart.content.type).toBe("group");
    if (multipart.content.type !== "group") {
      throw new Error("expected multipart group");
    }
    for (const item of multipart.content.items) {
      expect((item as unknown as IMessageMessage).attachmentMetadata).toEqual(
        multipart.attachmentMetadata
      );
    }
  });

  it("does not leak an unsupported Advanced message through custom content", async () => {
    const [message] = await toInboundMessages(
      { messages: {} } as unknown as AdvancedIMessage,
      new MessageCache(),
      receivedEvent(
        nativeMessage({
          content: {
            attachments: [],
            formatting: [],
            mentions: [],
            text: undefined,
          },
          itemType: "chatAction",
        })
      ),
      "+15550000000"
    );

    expect(message?.content).toEqual({
      raw: {
        imessage_type: "unsupported-message",
      },
      type: "custom",
    });
    if (message?.content.type !== "custom") {
      throw new Error("expected custom fallback");
    }
    expect(message.itemType).toBe("chatAction");
    expect(message.content.raw).not.toHaveProperty("guid");
    expect(message.content.raw).not.toHaveProperty("content");
    expect(message.content.raw).not.toHaveProperty("chatGuids");
  });
});
