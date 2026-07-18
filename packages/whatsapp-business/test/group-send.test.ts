import { type Message, UnsupportedError } from "@spectrum-ts/core";
import { asAttachment, asGroup, asText } from "@spectrum-ts/core/authoring";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppPartialSendError } from "@/errors/partial-send";
import { replyToMessage, send } from "@/messages";
import type { WhatsAppClients } from "@/types";

const outboundItem = (content: unknown): Message =>
  ({ id: "", content }) as unknown as Message;

const attachment = (mimeType: string, name = "photo.jpg") =>
  asAttachment({
    name,
    mimeType,
    read: async () => Buffer.from("bytes"),
  });

const fakeClients = () => {
  const sendSpy = vi.fn().mockResolvedValue({ messageId: "wamid.OUT1" });
  const upload = vi.fn().mockResolvedValue({ mediaId: "MEDIA1" });
  const clients = [
    { messages: { send: sendSpy }, media: { upload } },
  ] as unknown as WhatsAppClients;
  return { clients, sendSpy, upload };
};

describe("whatsapp outbound group content", () => {
  it("collapses an [attachment, text] pair into one captioned media send", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("image/jpeg")),
        outboundItem(asText("how many pieces left?")),
      ],
    });

    const record = await send(clients, "15550001111", group);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      image: { id: "MEDIA1", caption: "how many pieces left?" },
    });
    expect(record).toMatchObject({ id: "wamid.OUT1", content: group });
  });

  it("collapses a [text, attachment] pair regardless of order", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(asText("spec attached")),
        outboundItem(attachment("application/pdf", "spec.pdf")),
      ],
    });

    await send(clients, "15550001111", group);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      document: {
        id: "MEDIA1",
        filename: "spec.pdf",
        caption: "spec attached",
      },
    });
  });

  it("sends audio + text sequentially — audio cannot carry a caption", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("audio/mpeg", "song.mp3")),
        outboundItem(asText("new track")),
      ],
    });

    await send(clients, "15550001111", group);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      to: "15550001111",
      audio: { id: "MEDIA1" },
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      to: "15550001111",
      text: "new track",
    });
  });

  it("sends an over-limit caption sequentially instead of truncating", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("image/jpeg")),
        outboundItem(asText("x".repeat(1025))),
      ],
    });

    await send(clients, "15550001111", group);

    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("sends 3+ item groups sequentially", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("image/jpeg", "a.jpg")),
        outboundItem(attachment("image/jpeg", "b.jpg")),
        outboundItem(asText("album")),
      ],
    });

    const record = await send(clients, "15550001111", group);

    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(record).toMatchObject({ id: "wamid.OUT1", content: group });
  });

  it("quotes the reply target on the captioned send", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("image/jpeg")),
        outboundItem(asText("this one")),
      ],
    });

    await replyToMessage(clients, "15550001111", "wamid.TARGET1", group);

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      replyTo: "wamid.TARGET1",
      image: { id: "MEDIA1", caption: "this one" },
    });
  });

  it("reports already-delivered parts when a later sequential send fails", async () => {
    const { clients, sendSpy } = fakeClients();
    sendSpy
      .mockResolvedValueOnce({ messageId: "wamid.OUT1" })
      .mockRejectedValueOnce(new Error("cloud api down"));
    const group = asGroup({
      items: [
        outboundItem(attachment("audio/mpeg", "note.mp3")),
        outboundItem(asText("listen")),
      ],
    });

    const failure = await send(clients, "15550001111", group).catch(
      (error: unknown) => error
    );

    if (!(failure instanceof WhatsAppPartialSendError)) {
      throw new Error(`expected WhatsAppPartialSendError, got ${failure}`);
    }
    expect(failure.sent).toHaveLength(1);
    expect(failure.sent[0]).toMatchObject({ id: "wamid.OUT1" });
    expect(failure.failedIndex).toBe(1);
    expect(failure.cause).toMatchObject({ message: "cloud api down" });
  });

  it("rethrows the original error untouched when the first part fails", async () => {
    const { clients, sendSpy } = fakeClients();
    const boom = new Error("cloud api down");
    sendSpy.mockRejectedValueOnce(boom);
    const group = asGroup({
      items: [
        outboundItem(attachment("audio/mpeg", "note.mp3")),
        outboundItem(asText("listen")),
      ],
    });

    const failure = await send(clients, "15550001111", group).catch(
      (error: unknown) => error
    );

    expect(failure).toBe(boom);
    expect(failure).not.toBeInstanceOf(WhatsAppPartialSendError);
  });

  it("shields core fallbacks from replaying a partially-delivered group", async () => {
    // An UnsupportedError escaping mid-sequence would trigger core's
    // markdown-downgrade re-send of the WHOLE group, duplicating the parts
    // already delivered — so after a partial delivery it must surface as
    // WhatsAppPartialSendError instead.
    const { clients } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("image/jpeg", "a.jpg")),
        outboundItem(attachment("image/jpeg", "b.jpg")),
        outboundItem({ type: "markdown", markdown: "*hi*" }),
      ],
    });

    const failure = await send(clients, "15550001111", group).catch(
      (error: unknown) => error
    );

    if (!(failure instanceof WhatsAppPartialSendError)) {
      throw new Error(`expected WhatsAppPartialSendError, got ${failure}`);
    }
    expect(failure).not.toBeInstanceOf(UnsupportedError);
    expect(failure.sent).toHaveLength(2);
    expect(failure.cause).toBeInstanceOf(UnsupportedError);
  });

  it("quotes the reply target only on the first sequential part", async () => {
    const { clients, sendSpy } = fakeClients();
    const group = asGroup({
      items: [
        outboundItem(attachment("audio/mpeg", "note.mp3")),
        outboundItem(asText("listen")),
      ],
    });

    await replyToMessage(clients, "15550001111", "wamid.TARGET1", group);

    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      to: "15550001111",
      replyTo: "wamid.TARGET1",
      audio: { id: "MEDIA1" },
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      to: "15550001111",
      text: "listen",
    });
  });
});
