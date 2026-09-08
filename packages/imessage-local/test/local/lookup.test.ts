import type {
  Chat,
  IMessageSDK,
  Attachment as KitAttachment,
  Message as KitMessage,
} from "@photon-ai/imessage-kit";
import { describe, expect, it, vi } from "vitest";
import { toMessages } from "@/local/inbound";
import {
  getLocalAttachment,
  getLocalDisplayName,
  getLocalMessage,
} from "@/local/lookup";

const createdAt = new Date(1_700_000_000_000);

const attachment = (id: string): KitAttachment =>
  ({
    createdAt,
    fileName: `${id}.png`,
    id,
    isFromMe: false,
    isSensitiveContent: false,
    isSticker: false,
    localPath: `/tmp/${id}.png`,
    mimeType: "image/png",
    sizeBytes: 123,
    transferStatus: "complete",
    uti: "public.png",
  }) as KitAttachment;

const message = (
  id: string,
  attachments: readonly KitAttachment[] = []
): KitMessage =>
  ({
    attachments,
    chatId: "any;-;+15551234567",
    chatKind: "dm",
    createdAt,
    hasAttachments: attachments.length > 0,
    id,
    isAudioMessage: false,
    isFromMe: false,
    kind: "text",
    participant: "+15551234567",
    reaction: null,
    retractedAt: null,
    text: attachments.length > 0 ? undefined : "hello",
  }) as KitMessage;

const client = (overrides: Partial<IMessageSDK>): IMessageSDK =>
  Object.assign(Object.create(null), overrides) as IMessageSDK;

describe("local iMessage lookup", () => {
  it("finds a message by Apple GUID within its space", async () => {
    const getMessages = vi.fn(() => Promise.resolve([message("message-1")]));

    const found = await getLocalMessage(
      client({ getMessages }),
      "any;-;+15551234567",
      "message-1",
      toMessages
    );

    expect(found).toMatchObject({
      content: { text: "hello", type: "text" },
      id: "message-1",
    });
    expect(getMessages).toHaveBeenCalledWith({
      chatId: "any;-;+15551234567",
      limit: 200,
      offset: 0,
    });
  });

  it("resolves generated attachment child ids", async () => {
    const getMessages = vi.fn(() =>
      Promise.resolve([message("message-1", [attachment("attachment-1")])])
    );

    const found = await getLocalMessage(
      client({ getMessages }),
      "any;-;+15551234567",
      "message-1:attachment-1",
      toMessages
    );

    expect(found).toMatchObject({
      content: { id: "attachment-1", type: "attachment" },
      id: "message-1:attachment-1",
    });
  });

  it("finds an attachment by GUID", async () => {
    const getMessages = vi.fn(() =>
      Promise.resolve([message("message-1", [attachment("attachment-1")])])
    );

    const found = await getLocalAttachment(
      client({ getMessages }),
      "attachment-1"
    );

    expect(found).toMatchObject({
      id: "attachment-1",
      mimeType: "image/png",
      name: "attachment-1.png",
      size: 123,
      type: "attachment",
    });
  });

  it("reads a chat display name", async () => {
    const listChats = vi.fn(() =>
      Promise.resolve([{ name: "Family" } as Chat])
    );

    await expect(
      getLocalDisplayName(client({ listChats }), "any;+;chat-family")
    ).resolves.toBe("Family");
    expect(listChats).toHaveBeenCalledWith({
      chatId: "any;+;chat-family",
      limit: 1,
    });
  });
});
