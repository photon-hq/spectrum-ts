import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { describe, expect, it } from "vitest";
import { messages } from "@/messages";
import type { WhatsAppMessage } from "@/types";

// Drives the real inbound path — messages() -> clientStream -> toMessages —
// with a fake client whose event stream yields one media message.
const fakeMediaClient = (media: {
  id: string;
  mimeType: string;
  caption?: string;
}): WhatsAppClient => {
  const inbound = {
    id: "wamid.CAPTION1",
    from: "15551234567",
    timestamp: new Date("2026-07-14T00:00:00.000Z"),
    content: { type: "image", media },
  };
  const filtered = {
    async *[Symbol.asyncIterator]() {
      yield { type: "message", message: inbound };
    },
    close: async () => undefined,
  };
  return {
    events: { subscribe: () => ({ filter: () => filtered }) },
  } as unknown as WhatsAppClient;
};

const receiveOne = async (
  client: WhatsAppClient
): Promise<WhatsAppMessage | undefined> => {
  for await (const m of messages([client])) {
    return m;
  }
  return;
};

describe("whatsapp inbound media caption", () => {
  it("surfaces a captioned image as a group of [attachment, text]", async () => {
    const received = await receiveOne(
      fakeMediaClient({
        id: "983666494500094",
        mimeType: "image/jpeg",
        caption: "how many pieces left?",
      })
    );

    const content = received?.content;
    if (content?.type !== "group") {
      throw new Error(`expected group content, got ${content?.type}`);
    }
    expect(content.items).toHaveLength(2);

    // Each item must be a complete record — cloud webhook delivery
    // serializes item.sender/item.timestamp and crashes on undefined.
    for (const item of content.items) {
      expect(item.sender).toEqual({ id: "15551234567" });
      expect(item.timestamp).toEqual(new Date("2026-07-14T00:00:00.000Z"));
      expect(item.space).toEqual({ id: "15551234567" });
    }

    const [attachmentItem, textItem] = content.items;
    expect(attachmentItem?.id).toBe("wamid.CAPTION1:0");
    expect(attachmentItem?.content).toMatchObject({
      type: "attachment",
      id: "983666494500094",
      name: "media-983666494500094",
      mimeType: "image/jpeg",
    });
    expect(textItem?.id).toBe("wamid.CAPTION1:1");
    expect(textItem?.content).toMatchObject({
      type: "text",
      text: "how many pieces left?",
    });
  });

  it("keeps an uncaptioned image as a plain attachment", async () => {
    const received = await receiveOne(
      fakeMediaClient({ id: "983666494500094", mimeType: "image/jpeg" })
    );

    expect(received?.id).toBe("wamid.CAPTION1");
    expect(received?.content).toMatchObject({
      type: "attachment",
      id: "983666494500094",
      name: "media-983666494500094",
      mimeType: "image/jpeg",
    });
  });

  it("treats a whitespace-only caption as no caption", async () => {
    const received = await receiveOne(
      fakeMediaClient({
        id: "983666494500094",
        mimeType: "image/jpeg",
        caption: "   ",
      })
    );

    expect(received?.content).toMatchObject({ type: "attachment" });
  });
});
