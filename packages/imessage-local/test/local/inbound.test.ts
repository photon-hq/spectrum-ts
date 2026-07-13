import type { Message as LocalIMessage } from "@photon-ai/imessage-kit";
import { describe, expect, it } from "vitest";
import { toMessages } from "@/local/inbound";

const CREATED_AT = new Date(1_700_000_000_000);
const ATTACHMENT_PLACEHOLDER = "\uFFFC";
const DEFAULT_ATTACHMENT_SIZE_BYTES = 123;

const attachment = (
  id: string,
  fileName: string,
  mimeType: string,
  sizeBytes = DEFAULT_ATTACHMENT_SIZE_BYTES
): LocalIMessage["attachments"][number] =>
  ({
    fileName,
    id,
    isFromMe: false,
    isSticker: false,
    localPath: undefined,
    mimeType,
    sizeBytes,
    transferName: fileName,
    transferStatus: "finished",
    uti: undefined,
  }) as unknown as LocalIMessage["attachments"][number];

const localMessage = (overrides: Partial<LocalIMessage> = {}): LocalIMessage =>
  ({
    attachments: [],
    chatId: "chat-1",
    chatKind: "direct",
    createdAt: CREATED_AT,
    hasAttachments: false,
    id: "msg-1",
    kind: "text",
    participant: "+15551234567",
    reaction: null,
    retractedAt: null,
    text: "hi",
    ...overrides,
  }) as unknown as LocalIMessage;

const summarize = (message: Awaited<ReturnType<typeof toMessages>>[number]) => {
  if (message.content.type === "attachment") {
    return {
      content: {
        id: message.content.id,
        mimeType: message.content.mimeType,
        name: message.content.name,
        type: message.content.type,
      },
      id: message.id,
      partIndex: message.partIndex,
    };
  }

  return {
    content: message.content,
    id: message.id,
    partIndex: message.partIndex,
  };
};

describe("iMessage local toMessages", () => {
  it("keeps plain text messages as text", async () => {
    const messages = await toMessages(localMessage({ text: "plain text" }));

    expect(messages.map(summarize)).toEqual([
      {
        content: { text: "plain text", type: "text" },
        id: "msg-1",
        partIndex: undefined,
      },
    ]);
  });

  it("wraps plain text replies with the thread root target", async () => {
    const [message] = await toMessages(
      localMessage({
        text: "reply text",
        threadRootMessageId: "target-message",
      } as Partial<LocalIMessage>)
    );

    expect(message?.content.type).toBe("reply");
    if (message?.content.type !== "reply") {
      throw new Error("expected reply content");
    }
    expect(message.content.content).toEqual({
      text: "reply text",
      type: "text",
    });
    expect(message.content.target.id).toBe("target-message");
  });

  it("does not treat replyToMessageId alone as a public reply target", async () => {
    const [message] = await toMessages(
      localMessage({
        replyToMessageId: "diagnostic-message",
        text: "plain text",
      } as Partial<LocalIMessage>)
    );

    expect(message?.content).toEqual({ text: "plain text", type: "text" });
  });

  it("keeps a single attachment without text as a single attachment message", async () => {
    const messages = await toMessages(
      localMessage({
        attachments: [attachment("att-0", "IMG_9151.png", "image/png")],
        hasAttachments: true,
        text: undefined,
      })
    );

    expect(messages.map(summarize)).toEqual([
      {
        content: {
          id: "att-0",
          mimeType: "image/png",
          name: "IMG_9151.png",
          type: "attachment",
        },
        id: "msg-1:att-0",
        partIndex: undefined,
      },
    ]);
  });

  it("wraps attachment replies without changing the local message id", async () => {
    const [message] = await toMessages(
      localMessage({
        attachments: [attachment("att-0", "IMG_9151.png", "image/png")],
        hasAttachments: true,
        text: undefined,
        threadRootMessageId: "target-message",
      } as Partial<LocalIMessage>)
    );

    expect(message?.id).toBe("msg-1:att-0");
    expect(message?.content.type).toBe("reply");
    if (message?.content.type !== "reply") {
      throw new Error("expected reply content");
    }
    expect(message.content.target.id).toBe("target-message");
    expect(message.content.content.type).toBe("attachment");
    if (message.content.content.type === "attachment") {
      expect(message.content.content.id).toBe("att-0");
    }
  });

  it("keeps multiple attachments without usable text as attachment messages", async () => {
    const messages = await toMessages(
      localMessage({
        attachments: [
          attachment("att-0", "IMG_9151.png", "image/png"),
          attachment("att-1", "central.log", "application/octet-stream"),
        ],
        hasAttachments: true,
        text: ` ${ATTACHMENT_PLACEHOLDER}\n${ATTACHMENT_PLACEHOLDER} `,
      })
    );

    expect(messages.map(summarize)).toEqual([
      {
        content: {
          id: "att-0",
          mimeType: "image/png",
          name: "IMG_9151.png",
          type: "attachment",
        },
        id: "msg-1:att-0",
        partIndex: undefined,
      },
      {
        content: {
          id: "att-1",
          mimeType: "application/octet-stream",
          name: "central.log",
          type: "attachment",
        },
        id: "msg-1:att-1",
        partIndex: undefined,
      },
    ]);
  });

  it("reconstructs interleaved text and attachments in placeholder order", async () => {
    const messages = await toMessages(
      localMessage({
        attachments: [
          attachment("att-0", "IMG_9151.png", "image/png"),
          attachment("att-1", "central.log", "application/octet-stream"),
          attachment("att-2", "IMG_8883.png", "image/png"),
        ],
        hasAttachments: true,
        text: `Link, next image ${ATTACHMENT_PLACEHOLDER} image, next file ${ATTACHMENT_PLACEHOLDER} final image ${ATTACHMENT_PLACEHOLDER} final text`,
      })
    );

    expect(messages.map(summarize)).toEqual([
      {
        content: { text: "Link, next image", type: "text" },
        id: "msg-1:text:0",
        partIndex: 0,
      },
      {
        content: {
          id: "att-0",
          mimeType: "image/png",
          name: "IMG_9151.png",
          type: "attachment",
        },
        id: "msg-1:att-0",
        partIndex: 1,
      },
      {
        content: { text: "image, next file", type: "text" },
        id: "msg-1:text:2",
        partIndex: 2,
      },
      {
        content: {
          id: "att-1",
          mimeType: "application/octet-stream",
          name: "central.log",
          type: "attachment",
        },
        id: "msg-1:att-1",
        partIndex: 3,
      },
      {
        content: { text: "final image", type: "text" },
        id: "msg-1:text:4",
        partIndex: 4,
      },
      {
        content: {
          id: "att-2",
          mimeType: "image/png",
          name: "IMG_8883.png",
          type: "attachment",
        },
        id: "msg-1:att-2",
        partIndex: 5,
      },
      {
        content: { text: "final text", type: "text" },
        id: "msg-1:text:6",
        partIndex: 6,
      },
    ]);
  });

  it("wraps each local interleaved reply part without changing order", async () => {
    const messages = await toMessages(
      localMessage({
        attachments: [
          attachment("att-0", "IMG_9151.png", "image/png"),
          attachment("att-1", "central.log", "application/octet-stream"),
        ],
        hasAttachments: true,
        text: `before ${ATTACHMENT_PLACEHOLDER} after ${ATTACHMENT_PLACEHOLDER}`,
        threadRootMessageId: "target-message",
      } as Partial<LocalIMessage>)
    );

    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.content.type)).toEqual([
      "reply",
      "reply",
      "reply",
      "reply",
    ]);
    const inners = messages.map((message) =>
      message.content.type === "reply" ? message.content.content.type : "none"
    );
    expect(inners).toEqual(["text", "attachment", "text", "attachment"]);
    expect(
      messages.map((message) =>
        message.content.type === "reply" ? message.content.target.id : ""
      )
    ).toEqual([
      "target-message",
      "target-message",
      "target-message",
      "target-message",
    ]);
    expect(messages.map((message) => message.partIndex)).toEqual([0, 1, 2, 3]);
  });

  it("keeps attachment indexes stable when text has no placeholder", async () => {
    const messages = await toMessages(
      localMessage({
        attachments: [attachment("att-0", "IMG_9151.png", "image/png")],
        hasAttachments: true,
        text: "caption without placeholder",
      })
    );

    expect(messages.map(summarize)).toEqual([
      {
        content: {
          id: "att-0",
          mimeType: "image/png",
          name: "IMG_9151.png",
          type: "attachment",
        },
        id: "msg-1:att-0",
        partIndex: 0,
      },
      {
        content: { text: "caption without placeholder", type: "text" },
        id: "msg-1:text:1",
        partIndex: 1,
      },
    ]);
  });

  it("drops pending attachment joins until attachments settle", async () => {
    const messages = await toMessages(
      localMessage({
        attachments: [],
        hasAttachments: true,
        text: ATTACHMENT_PLACEHOLDER,
      })
    );

    expect(messages).toEqual([]);
  });
});
