import type {
  AdvancedIMessage,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage";
import {
  type Content,
  type Message,
  markdown,
  UnsupportedError,
} from "@spectrum-ts/core";
import {
  asAttachment,
  asGroup,
  asMarkdown,
  asText,
} from "@spectrum-ts/core/authoring";
import { describe, expect, it, vi } from "vitest";
import { effect } from "@/content/effect";
import { editMessage, replyToMessage, send } from "@/remote/send";

const SENT_DATE = new Date(1_700_000_000_000);
const SLAM = "com.apple.MobileSMS.expressivesend.impact";

const makeRemote = () => {
  const reply = {
    guid: "msg-guid",
    dateCreated: SENT_DATE,
  } as unknown as SDKMessage;
  const sendText = vi.fn((_chat: string, _text: string, _options?: unknown) =>
    Promise.resolve(reply)
  );
  const sendMultipart = vi.fn((_chat: string, _parts: unknown) =>
    Promise.resolve(reply)
  );
  const edit = vi.fn(() => Promise.resolve(reply));
  const upload = vi.fn(() =>
    Promise.resolve({ attachment: { guid: "att-guid" } })
  );
  const remote = {
    messages: { sendText, sendMultipart, edit },
    attachments: { upload },
  } as unknown as AdvancedIMessage;
  return { remote, sendText, sendMultipart, edit, upload };
};

// Outbound group items are stub messages — providers only read `.content`
// (mirrors `group()`'s internal stubOutboundMessage).
const groupOf = (...contents: Content[]) =>
  asGroup({
    items: contents.map(
      (content) => ({ id: "", content }) as unknown as Message
    ),
  });

describe("send (markdown)", () => {
  it("sends rendered text with formatting ranges", async () => {
    const { remote, sendText } = makeRemote();
    const content = asMarkdown("# Hi\n\n**bold** move");

    const record = await send(remote, "chat", content);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]).toEqual([
      "chat",
      "Hi\n\nbold move",
      {
        formatting: [
          { type: "bold", start: 0, length: 2 },
          { type: "bold", start: 4, length: 4 },
        ],
      },
    ]);
    expect(record.id).toBe("msg-guid");
    expect(record.timestamp).toEqual(SENT_DATE);
    // The record keeps the original markdown content, not the rendered text.
    expect(record.content).toEqual(content);
    expect(record.space).toEqual({ id: "chat" });
  });

  it("omits formatting for unstyled markdown", async () => {
    const { remote, sendText } = makeRemote();

    await send(remote, "chat", asMarkdown("just words"));

    expect(sendText.mock.calls[0]).toEqual(["chat", "just words", {}]);
  });

  it("sends link-bearing markdown as plain text (no data detection)", async () => {
    const { remote, sendText } = makeRemote();

    await send(remote, "chat", asMarkdown("[docs](https://d.test)"));

    expect(sendText.mock.calls[0]).toEqual([
      "chat",
      "docs (https://d.test)",
      {},
    ]);
  });

  it("sends markdown replies with formatting and the reply target", async () => {
    const { remote, sendText } = makeRemote();

    await replyToMessage(remote, "chat", "target-id", asMarkdown("**a**"));

    expect(sendText.mock.calls[0]).toEqual([
      "chat",
      "a",
      {
        formatting: [{ type: "bold", start: 0, length: 1 }],
        replyTo: "target-id",
      },
    ]);
  });

  it("carries an effect wrapper alongside formatting", async () => {
    const { remote, sendText } = makeRemote();
    // Built via the real builder so the effect schema's inner-content union
    // is exercised, not bypassed.
    const content = await effect(markdown("**a**"), SLAM).build();

    await send(remote, "chat", content);

    expect(sendText.mock.calls[0]).toEqual([
      "chat",
      "a",
      {
        effect: SLAM,
        formatting: [{ type: "bold", start: 0, length: 1 }],
      },
    ]);
  });

  it("renders a markdown group item as a formatted multipart text part", async () => {
    const { remote, sendMultipart, upload } = makeRemote();
    const pic = asAttachment({
      name: "pic.png",
      mimeType: "image/png",
      read: () => Promise.resolve(Buffer.from("x")),
    });

    await send(remote, "chat", groupOf(asMarkdown("**a** b"), pic));

    expect(upload).toHaveBeenCalledTimes(1);
    expect(sendMultipart).toHaveBeenCalledTimes(1);
    expect(sendMultipart.mock.calls[0]).toEqual([
      "chat",
      [
        {
          text: "a b",
          formatting: [{ type: "bold", start: 0, length: 1 }],
          bubbleIndex: 0,
        },
        {
          attachmentGuid: "att-guid",
          attachmentName: "pic.png",
          bubbleIndex: 1,
        },
      ],
    ]);
  });

  it("counts markdown toward the group text-item cap", async () => {
    const { remote, sendMultipart } = makeRemote();

    await expect(
      send(remote, "chat", groupOf(asMarkdown("**a**"), asText("b")))
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(sendMultipart).not.toHaveBeenCalled();
  });

  it("rejects markdown that renders to empty text without sending", async () => {
    const { remote, sendText } = makeRemote();

    await expect(
      send(remote, "chat", asMarkdown("   "))
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("still rejects markdown edits (the wire carries no formatting)", async () => {
    const { remote, edit } = makeRemote();

    await expect(
      editMessage(remote, "chat", "msg-1", asMarkdown("**a**"))
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(edit).not.toHaveBeenCalled();
  });
});
