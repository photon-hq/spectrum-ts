import { describe, expect, it } from "bun:test";
import type {
  AdvancedIMessage,
  MessageEvent,
} from "@photon-ai/advanced-imessage";
import { MessageCache } from "@/cache";
import { toInboundMessages } from "@/remote/inbound";

type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;
type AttachmentContent = Extract<
  Awaited<ReturnType<typeof toInboundMessages>>[number]["content"],
  { type: "attachment" }
>;
type GroupItem = Extract<
  Awaited<ReturnType<typeof toInboundMessages>>[number]["content"],
  { type: "group" }
>["items"][number];

const RECEIVED_AT = new Date(1_700_000_000_000);
const ATTACHMENT_PLACEHOLDER = "\uFFFC";

// A plain text message never touches the client (no attachment download), so a
// bare stub is enough to exercise the sender-normalization path.
const client = {} as unknown as AdvancedIMessage;

const receivedEvent = (
  sender?: Record<string, unknown>,
  content?: Record<string, unknown>
): ReceivedEvent =>
  ({
    type: "message.received",
    sequence: 1,
    chatGuid: "s1",
    isFromMe: false,
    occurredAt: RECEIVED_AT,
    message: {
      guid: "msg-guid",
      chatGuids: ["s1"],
      content: {
        attachments: [],
        formatting: [],
        mentions: [],
        text: "hi",
        ...content,
      },
      dateCreated: RECEIVED_AT,
      isFromMe: false,
      sender,
    },
  }) as unknown as ReceivedEvent;

const attachment = (
  guid: string,
  fileName: string,
  mimeType: string,
  totalBytes = 123
) => ({
  guid,
  fileName,
  mimeType,
  totalBytes,
});

const summarizeGroupItem = (item: GroupItem) => {
  if (item.content.type === "attachment") {
    return {
      content: {
        id: item.content.id,
        mimeType: item.content.mimeType,
        name: item.content.name,
        type: item.content.type,
      },
      id: item.id,
      parentId: (item as { parentId?: string }).parentId,
      partIndex: (item as { partIndex?: number }).partIndex,
    };
  }

  return {
    content: item.content,
    id: item.id,
    parentId: (item as { parentId?: string }).parentId,
    partIndex: (item as { partIndex?: number }).partIndex,
  };
};

const summarizeCaptionItem = (item: GroupItem) => {
  if (item.content.type === "attachment") {
    return {
      id: item.content.id,
      partIndex: (item as { partIndex?: number }).partIndex,
      type: item.content.type,
    };
  }

  return {
    partIndex: (item as { partIndex?: number }).partIndex,
    text: item.content.type === "text" ? item.content.text : undefined,
    type: item.content.type,
  };
};

const inboundSender = async (sender?: Record<string, unknown>) => {
  const messages = await toInboundMessages(
    client,
    new MessageCache(),
    receivedEvent(sender),
    "+15550000000"
  );
  return messages[0]?.sender;
};

describe("iMessage remote toInboundMessages sender", () => {
  it("surfaces address, country, and service from an iMessage sender", async () => {
    expect(
      await inboundSender({
        address: "+15551234567",
        country: "us",
        service: "iMessage",
      })
    ).toEqual({
      id: "+15551234567",
      address: "+15551234567",
      country: "us",
      service: "iMessage",
    });
  });

  it("reports the SMS service for green-bubble senders and omits absent country", async () => {
    expect(
      await inboundSender({ address: "+15551234567", service: "SMS" })
    ).toEqual({
      id: "+15551234567",
      address: "+15551234567",
      service: "SMS",
    });
  });

  it("falls back to an empty id when the sender is absent", async () => {
    expect(await inboundSender(undefined)).toEqual({ id: "" });
  });
});

describe("iMessage remote toInboundMessages content", () => {
  it("keeps plain text messages as text", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent({ address: "+15551234567" }, { text: "plain text" }),
      "+15550000000"
    );

    expect(message?.id).toBe("msg-guid");
    expect(message?.content).toEqual({ type: "text", text: "plain text" });
    expect((message as { partIndex?: number } | undefined)?.partIndex).toBe(
      undefined
    );
  });

  it("surfaces a URL balloon as plain text rather than a rich link", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent(
        { address: "+15551234567" },
        {
          text: "https://example.com/post",
          balloonBundleId: "com.apple.messages.URLBalloonProvider",
        }
      ),
      "+15550000000"
    );
    expect(message?.content).toEqual({
      type: "text",
      text: "https://example.com/post",
    });
  });

  it("keeps a single attachment without text as a single attachment message", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent(
        { address: "+15551234567" },
        {
          attachments: [attachment("att-0", "IMG_9151.png", "image/png")],
          text: undefined,
        }
      ),
      "+15550000000"
    );

    expect(message?.id).toBe("msg-guid");
    expect(message?.content.type).toBe("attachment");
    if (message?.content.type === "attachment") {
      expect(message.content.id).toBe("att-0");
      expect(message.content.name).toBe("IMG_9151.png");
    }
    expect((message as { partIndex?: number } | undefined)?.partIndex).toBe(0);
    expect((message as { parentId?: string } | undefined)?.parentId).toBe(
      undefined
    );
  });

  it("keeps multiple attachments without usable text as an attachment-only group", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent(
        { address: "+15551234567" },
        {
          attachments: [
            attachment("att-0", "IMG_9151.png", "image/png"),
            attachment("att-1", "central.log", "application/octet-stream"),
          ],
          text: ` ${ATTACHMENT_PLACEHOLDER} \n${ATTACHMENT_PLACEHOLDER} `,
        }
      ),
      "+15550000000"
    );

    expect(message?.content.type).toBe("group");
    if (message?.content.type !== "group") {
      throw new Error("expected attachment-only group");
    }

    expect(message.content.items.map(summarizeCaptionItem)).toEqual([
      { id: "att-0", partIndex: 0, type: "attachment" },
      { id: "att-1", partIndex: 1, type: "attachment" },
    ]);
  });

  it("reconstructs interleaved text and attachments in placeholder order", async () => {
    const cache = new MessageCache();
    const [message] = await toInboundMessages(
      client,
      cache,
      receivedEvent(
        { address: "+15551234567" },
        {
          attachments: [
            attachment("att-0", "IMG_9151.png", "image/png"),
            attachment("att-1", "central.log", "application/octet-stream"),
            attachment("att-2", "IMG_8883.png", "image/png"),
          ],
          text: `Link, next iamge ${ATTACHMENT_PLACEHOLDER} \n\nimage, next file${ATTACHMENT_PLACEHOLDER}final image ${ATTACHMENT_PLACEHOLDER}final text\n`,
        }
      ),
      "+15550000000"
    );

    expect(message?.content.type).toBe("group");
    if (message?.content.type !== "group") {
      throw new Error("expected grouped interleaved content");
    }

    expect(message.content.items.map(summarizeGroupItem)).toEqual([
      {
        content: { type: "text", text: "Link, next iamge" },
        id: "p:0/msg-guid",
        parentId: "msg-guid",
        partIndex: 0,
      },
      {
        content: {
          id: "att-0",
          mimeType: "image/png",
          name: "IMG_9151.png",
          type: "attachment",
        },
        id: "p:1/msg-guid",
        parentId: "msg-guid",
        partIndex: 1,
      },
      {
        content: { type: "text", text: "image, next file" },
        id: "p:2/msg-guid",
        parentId: "msg-guid",
        partIndex: 2,
      },
      {
        content: {
          id: "att-1",
          mimeType: "application/octet-stream",
          name: "central.log",
          type: "attachment",
        },
        id: "p:3/msg-guid",
        parentId: "msg-guid",
        partIndex: 3,
      },
      {
        content: { type: "text", text: "final image" },
        id: "p:4/msg-guid",
        parentId: "msg-guid",
        partIndex: 4,
      },
      {
        content: {
          id: "att-2",
          mimeType: "image/png",
          name: "IMG_8883.png",
          type: "attachment",
        },
        id: "p:5/msg-guid",
        parentId: "msg-guid",
        partIndex: 5,
      },
      {
        content: { type: "text", text: "final text" },
        id: "p:6/msg-guid",
        parentId: "msg-guid",
        partIndex: 6,
      },
    ]);
    expect(cache.get("p:0/msg-guid")?.content).toEqual({
      type: "text",
      text: "Link, next iamge",
    });
    expect(
      (cache.get("p:5/msg-guid")?.content as AttachmentContent | undefined)?.id
    ).toBe("att-2");
  });

  it("keeps captions around a single attachment", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent(
        { address: "+15551234567" },
        {
          attachments: [attachment("att-0", "IMG_9151.png", "image/png")],
          text: `before ${ATTACHMENT_PLACEHOLDER} after`,
        }
      ),
      "+15550000000"
    );

    expect(message?.content.type).toBe("group");
    if (message?.content.type !== "group") {
      throw new Error("expected grouped captioned attachment");
    }

    expect(message.content.items.map(summarizeCaptionItem)).toEqual([
      { partIndex: 0, text: "before", type: "text" },
      { id: "att-0", partIndex: 1, type: "attachment" },
      { partIndex: 2, text: "after", type: "text" },
    ]);
  });

  it("keeps attachment indexes stable when text has no placeholder", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent(
        { address: "+15551234567" },
        {
          attachments: [attachment("att-0", "IMG_9151.png", "image/png")],
          text: "caption without placeholder",
        }
      ),
      "+15550000000"
    );

    expect(message?.content.type).toBe("group");
    if (message?.content.type !== "group") {
      throw new Error("expected grouped captioned attachment");
    }

    expect(message.content.items.map(summarizeCaptionItem)).toEqual([
      { id: "att-0", partIndex: 0, type: "attachment" },
      { partIndex: 1, text: "caption without placeholder", type: "text" },
    ]);
  });
});
