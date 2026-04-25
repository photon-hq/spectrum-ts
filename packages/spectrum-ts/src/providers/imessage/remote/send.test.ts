import { describe, expect, test } from "bun:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { asAttachment } from "../../../content/attachment";
import { asContact } from "../../../content/contact";
import { asGroup } from "../../../content/group";
import { asRichlink } from "../../../content/richlink";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import { asVoice } from "../../../content/voice";
import type { Message } from "../../../types/message";
import { replyToMessage, send } from "./api";

interface SendCall {
  options: unknown;
  text: string;
}

interface UploadCall {
  data: Buffer;
  fileName?: string;
  mimeType?: string;
}

const stubMessage = (id: string, content: Content): Message =>
  ({ id, content }) as unknown as Message;

const createRemote = () => {
  const sendCalls: SendCall[] = [];
  const uploadCalls: UploadCall[] = [];

  const remote = {
    attachments: {
      upload: async (input: UploadCall) => {
        uploadCalls.push(input);
        return { guid: `att-${uploadCalls.length}` };
      },
    },
    messages: {
      send: async (_chat: unknown, text: string, options?: unknown) => {
        sendCalls.push({ text, options });
        return { guid: `msg-${sendCalls.length}` };
      },
    },
  } as unknown as AdvancedIMessage;

  return { remote, sendCalls, uploadCalls };
};

describe("remote iMessage send", () => {
  test("send and reply share content handling", async () => {
    const { remote, sendCalls, uploadCalls } = createRemote();

    const textResult = await send([remote], "chat-guid", asText("hello"));
    expect(textResult.id).toBe("msg-1");
    expect(sendCalls[0]?.text).toBe("hello");

    await replyToMessage(
      [remote],
      "chat-guid",
      "reply-guid",
      asRichlink({ url: "https://example.com" })
    );
    expect(sendCalls[1]?.text).toBe("https://example.com");
    expect(sendCalls[1]?.options).toMatchObject({
      richLink: true,
      replyTo: expect.anything(),
    });

    await send(
      [remote],
      "chat-guid",
      asAttachment({
        name: "note.txt",
        mimeType: "text/plain",
        read: async () => Buffer.from("note"),
      })
    );
    expect(uploadCalls[0]).toMatchObject({
      fileName: "note.txt",
      mimeType: "text/plain",
    });
    expect(sendCalls[2]?.options).toMatchObject({ attachment: "att-1" });

    await replyToMessage(
      [remote],
      "chat-guid",
      "reply-guid",
      asContact({ name: { formatted: "Ada Lovelace" } })
    );
    expect(uploadCalls[1]).toMatchObject({
      fileName: "Ada_Lovelace.vcf",
      mimeType: "text/vcard",
    });
    expect(sendCalls[3]?.options).toMatchObject({
      attachment: "att-2",
      replyTo: expect.anything(),
    });

    await send(
      [remote],
      "chat-guid",
      asVoice({
        name: "voice.m4a",
        mimeType: "audio/mp4",
        read: async () => Buffer.from("not-real-m4a"),
      })
    );
    expect(uploadCalls[2]).toMatchObject({
      fileName: "voice.m4a",
      mimeType: "audio/x-m4a",
    });
    expect(sendCalls[4]?.options).toMatchObject({
      attachment: "att-3",
      audioMessage: true,
    });
  });

  test("rejects unsupported group items before native send", async () => {
    const { remote, sendCalls } = createRemote();
    const content = asGroup({
      items: [
        stubMessage("one", asText("unsupported")),
        stubMessage("two", asText("also unsupported")),
      ],
    });

    await expect(send([remote], "chat-guid", content)).rejects.toThrow(
      '"text" items are not supported inside a group'
    );
    expect(sendCalls).toHaveLength(0);
  });
});
