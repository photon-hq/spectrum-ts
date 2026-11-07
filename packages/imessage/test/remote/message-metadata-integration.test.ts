import {
  type AdvancedIMessage,
  type MessageEvent,
  type MiniAppCardSession,
  type MiniAppMessageResult,
  NotFoundError,
  type Message as SDKMessage,
} from "@photon-ai/advanced-imessage/grpc";
import type { Content, Message } from "@spectrum-ts/core";
import { asAttachment, asGroup, asText } from "@spectrum-ts/core/authoring";
import { describe, expect, it, vi } from "vitest";
import { getMessageCache, MessageCache } from "@/cache";
import { asCustomizedMiniApp } from "@/content/customized-mini-app";
import { imessage } from "@/index";
import {
  getMessage,
  type ReceivedEvent,
  toInboundMessages,
} from "@/remote/inbound";
import { send } from "@/remote/send";
import { type IMessageMessage, type RemoteClient, SHARED_PHONE } from "@/types";

const CREATED_AT = new Date("2026-02-03T04:05:06.000Z");
const DELIVERED_AT = new Date("2026-02-03T04:05:07.000Z");
const READ_AT = new Date("2026-02-03T04:05:08.000Z");
const ATTACHMENT_PLACEHOLDER = "\uFFFC";
const SENDER_DEVICE_ID = `pho_device_v1_${"a".repeat(64)}`;
const OTHER_DEVICE_ID = `pho_device_v1_${"b".repeat(64)}`;

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

const sentRecord = (
  overrides: Partial<IMessageMessage> = {}
): IMessageMessage =>
  ({
    content: asText("Hello @Taylor"),
    direction: "outbound",
    id: "message-guid",
    space: { id: "iMessage;+;chat-guid" },
    timestamp: CREATED_AT,
    ...overrides,
  }) as IMessageMessage;

describe("curated metadata across native message paths", () => {
  it("includes metadata on ordinary inbound messages without extra RPCs", async () => {
    const get = vi.fn();
    const remote = { messages: { get } } as unknown as AdvancedIMessage;

    const [message] = await toInboundMessages(
      remote,
      new MessageCache(),
      receivedEvent(nativeMessage({ senderDeviceId: SENDER_DEVICE_ID })),
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
      senderDeviceId: SENDER_DEVICE_ID,
    });
  });

  it("includes metadata on getMessage and reads the server every time", async () => {
    const get = vi.fn(() =>
      Promise.resolve(nativeMessage({ senderDeviceId: SENDER_DEVICE_ID }))
    );
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

    expect(get).toHaveBeenCalledTimes(2);
    expect(first?.dateDelivered).toEqual(DELIVERED_AT);
    expect(first?.nativeText).toBe("Hello @Taylor");
    expect(first?.senderDeviceId).toBe(SENDER_DEVICE_ID);
    expect(second).toEqual(first);
  });

  it("reads the current state from the server when the message is cached", async () => {
    const get = vi.fn(() => Promise.resolve(nativeMessage({ isFromMe: true })));
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;
    const sent = sentRecord({ isDelivered: false });
    getMessageCache(remote).set("message-guid", sent);

    const message = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "message-guid",
      "+15550000000"
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(message?.isDelivered).toBe(true);
    expect(message?.dateDelivered).toEqual(DELIVERED_AT);
    expect(message?.dateRead).toEqual(READ_AT);
    expect(message?.content).toBe(sent.content);
    expect(getMessageCache(remote).get("message-guid")).toBe(sent);
  });

  it("throws server errors other than not found even when cached", async () => {
    const failure = new Error("unavailable");
    const remote = {
      messages: { get: vi.fn(() => Promise.reject(failure)) },
    } as unknown as AdvancedIMessage;
    getMessageCache(remote).set("message-guid", sentRecord());

    await expect(
      getMessage(remote, "iMessage;+;chat-guid", "message-guid", "+15550000000")
    ).rejects.toBe(failure);
  });

  for (const id of ["message-guid", "p:0/message-guid"]) {
    it.each([
      [
        "preserves the cached ID when omitted",
        SENDER_DEVICE_ID,
        undefined,
        SENDER_DEVICE_ID,
      ],
      [
        "preserves the cached ID when empty",
        SENDER_DEVICE_ID,
        "",
        SENDER_DEVICE_ID,
      ],
      [
        "prefers the fetched ID",
        SENDER_DEVICE_ID,
        OTHER_DEVICE_ID,
        OTHER_DEVICE_ID,
      ],
      [
        "adds a previously missing ID",
        undefined,
        SENDER_DEVICE_ID,
        SENDER_DEVICE_ID,
      ],
      ["does not invent a missing ID", undefined, undefined, undefined],
    ])(`cached ${id}: %s`, async (_name, cachedId, fetchedId, expectedId) => {
      const get = vi.fn(() =>
        Promise.resolve(
          nativeMessage(
            fetchedId === undefined ? {} : { senderDeviceId: fetchedId }
          )
        )
      );
      const remote = { messages: { get } } as unknown as AdvancedIMessage;
      const cached = sentRecord({
        id,
        isDelivered: false,
        senderDeviceId: cachedId,
      });
      getMessageCache(remote).set(id, cached);

      const message = await getMessage(
        remote,
        "iMessage;+;chat-guid",
        id,
        "+15550000000"
      );

      expect(get).toHaveBeenCalledExactlyOnceWith("message-guid");
      expect(message?.id).toBe(id);
      expect(message?.senderDeviceId).toBe(expectedId);
      expect(message?.isDelivered).toBe(true);
      expect(message?.dateRead).toEqual(READ_AT);
      expect(message?.content).toBe(cached.content);
      expect(getMessageCache(remote).get(id)).toBe(cached);
      expect(cached.senderDeviceId).toBe(cachedId);
    });
  }

  it("returns the cached message when the server does not have it", async () => {
    const get = vi.fn(() =>
      Promise.reject(
        new NotFoundError("message not found", {
          code: "messageNotFound",
          grpcCode: 5,
          retryable: false,
        })
      )
    );
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;
    const sent = sentRecord();
    getMessageCache(remote).set("message-guid", sent);

    const message = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "message-guid",
      "+15550000000"
    );

    expect(message).toBe(sent);
  });

  it("keeps the card session so a fetched card can still be edited", async () => {
    const session: MiniAppCardSession = {
      chatGuid: "iMessage;-;+15551230001",
      messageGuid: "message-guid",
      sessionId: "session-id",
      targetMessageGuid: "message-guid",
    };
    const result = {
      dateCreated: CREATED_AT,
      guid: "message-guid",
      miniAppCardSession: session,
    } as MiniAppMessageResult;
    const get = vi.fn(() => Promise.resolve(nativeMessage({ isFromMe: true })));
    const sendCustomizedMiniApp = vi.fn(() => Promise.resolve(result));
    const updateCustomizedMiniApp = vi.fn(() => Promise.resolve(result));
    const client: RemoteClient[] = [
      {
        client: {
          messages: { get, sendCustomizedMiniApp, updateCustomizedMiniApp },
        } as unknown as AdvancedIMessage,
        phone: SHARED_PHONE,
      },
    ];
    const def = imessage.config({}).__definition;
    const ctx = { client, config: {} as never, store: undefined as never };
    const space = {
      id: "iMessage;-;+15551230001",
      phone: SHARED_PHONE,
      type: "dm" as const,
    };
    const card = asCustomizedMiniApp({
      appName: "Example",
      extensionBundleId: "com.example.Messages",
      layout: { caption: "Card" },
      live: false,
      teamId: "ABCDE12345",
      url: "https://x.example/card",
    });

    await def.send({ ...ctx, content: card as never, space });
    const fetched = await def.actions?.getMessage?.(ctx, space, "message-guid");
    await def.send({
      ...ctx,
      content: { content: card, target: fetched, type: "edit" } as never,
      space,
    });

    expect(fetched).toMatchObject({
      dateDelivered: DELIVERED_AT,
      isDelivered: true,
    });
    expect(updateCustomizedMiniApp).toHaveBeenCalledWith(session, card);
  });

  it("refreshes a cached multipart child from the server without overwriting it", async () => {
    const get = vi.fn(() => Promise.resolve(nativeMessage({ isFromMe: true })));
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;
    const sent = sentRecord({ id: "p:0/message-guid", isDelivered: false });
    getMessageCache(remote).set("p:0/message-guid", sent);

    const message = await getMessage(
      remote,
      "iMessage;+;chat-guid",
      "p:0/message-guid",
      "+15550000000"
    );

    expect(get).toHaveBeenCalledWith("message-guid");
    expect(message?.id).toBe("p:0/message-guid");
    expect(message?.isDelivered).toBe(true);
    expect(message?.content).toBe(sent.content);
    expect(getMessageCache(remote).get("p:0/message-guid")).toBe(sent);
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
          senderDeviceId: SENDER_DEVICE_ID,
        })
      ),
      "+15550000000"
    );

    expect(parent?.content.type).toBe("group");
    if (parent?.content.type !== "group") {
      throw new Error("expected multipart group");
    }

    expect(parent.partCount).toBe(3);
    expect(parent.senderDeviceId).toBe(SENDER_DEVICE_ID);
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
      expect(child.senderDeviceId).toBe(SENDER_DEVICE_ID);
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
