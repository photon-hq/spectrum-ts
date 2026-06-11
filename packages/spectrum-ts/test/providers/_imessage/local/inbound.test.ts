import { describe, expect, it } from "bun:test";
import type { Message as LocalIMessage } from "@photon-ai/imessage-kit";
import { toMessages } from "@/providers/imessage/local/inbound";
import type { IMessageMessage } from "@/providers/imessage/types";

const SENT_DATE = new Date(1_700_000_000_000);
// Apple stores attachment placeholders in message text as U+FFFC.
const ATTACHMENT_PLACEHOLDER = "\uFFFC";

type LocalAttachment = LocalIMessage["attachments"][number];

const attachment = (id: string, fileName: string): LocalAttachment =>
  ({
    id,
    fileName,
    localPath: `/tmp/${fileName}`,
    mimeType: "image/jpeg",
    sizeBytes: 123,
  }) as LocalAttachment;

const localMessage = (input: {
  attachments?: LocalAttachment[];
  id?: string;
  text?: string | null;
}): LocalIMessage => {
  const attachments = input.attachments ?? [];
  return {
    id: input.id ?? "local-msg",
    attachments,
    chatId: "chat-1",
    chatKind: "dm",
    createdAt: SENT_DATE,
    hasAttachments: attachments.length > 0,
    kind: "text",
    participant: "+15550100",
    reaction: null,
    retractedAt: null,
    text: input.text ?? null,
  } as unknown as LocalIMessage;
};

const groupItems = (message: IMessageMessage): IMessageMessage[] => {
  if (message.content.type !== "group") {
    throw new Error("expected group content");
  }
  return message.content.items as unknown as IMessageMessage[];
};

describe("iMessage local inbound", () => {
  it("keeps a bare single attachment as attachment content", async () => {
    const [message] = await toMessages(
      localMessage({ attachments: [attachment("att-1", "photo.jpg")] })
    );

    expect(message).toMatchObject({
      id: "local-msg:att-1",
      content: {
        type: "attachment",
        id: "att-1",
        name: "photo.jpg",
      },
    });
    expect(message?.parentId).toBeUndefined();
    expect(message?.partIndex).toBeUndefined();
  });

  it("groups caption text with attachments", async () => {
    const [message] = await toMessages(
      localMessage({
        attachments: [attachment("att-1", "photo.jpg")],
        text: `Look at this${ATTACHMENT_PLACEHOLDER}`,
      })
    );

    if (!message) {
      throw new Error("expected grouped message");
    }
    const items = groupItems(message);

    expect(message.id).toBe("local-msg");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "local-msg:text",
      parentId: "local-msg",
      partIndex: 0,
      content: { type: "text", text: "Look at this" },
    });
    expect(items[1]).toMatchObject({
      id: "local-msg:att-1",
      parentId: "local-msg",
      partIndex: 1,
      content: {
        type: "attachment",
        id: "att-1",
        name: "photo.jpg",
      },
    });
  });

  it("groups multiple attachments from one local message", async () => {
    const [message] = await toMessages(
      localMessage({
        attachments: [
          attachment("att-1", "photo-1.jpg"),
          attachment("att-2", "photo-2.jpg"),
        ],
      })
    );

    if (!message) {
      throw new Error("expected grouped message");
    }
    const items = groupItems(message);

    expect(message.id).toBe("local-msg");
    expect(items.map((item) => item.id)).toEqual([
      "local-msg:att-1",
      "local-msg:att-2",
    ]);
    expect(items.map((item) => item.partIndex)).toEqual([0, 1]);
  });
});
