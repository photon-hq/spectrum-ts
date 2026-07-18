import type { Content } from "@spectrum-ts/core";
import { asRichlink } from "@spectrum-ts/core/authoring";
import { describe, expect, it, vi } from "vitest";
import { replyToMessage, send } from "@/messages";
import type { WhatsAppClients } from "@/types";

const fakeClients = () => {
  const sendSpy = vi.fn().mockResolvedValue({ messageId: "wamid.OUT1" });
  const clients = [
    { messages: { send: sendSpy } },
  ] as unknown as WhatsAppClients;
  return { clients, sendSpy };
};

const appContent = (url: string): Content =>
  ({ type: "app", url: async () => url }) as unknown as Content;

describe("whatsapp outbound link previews", () => {
  it("sends richlink as text with a native link preview", async () => {
    const { clients, sendSpy } = fakeClients();

    const record = await send(
      clients,
      "15550001111",
      asRichlink({ url: "https://example.com/post" })
    );

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      text: { body: "https://example.com/post", previewUrl: true },
    });
    expect(record).toMatchObject({ id: "wamid.OUT1" });
  });

  it("sends app content as its URL with a link preview", async () => {
    const { clients, sendSpy } = fakeClients();

    await send(clients, "15550001111", appContent("https://example.com/app"));

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      text: { body: "https://example.com/app", previewUrl: true },
    });
  });

  it("quotes the reply target on a richlink reply", async () => {
    const { clients, sendSpy } = fakeClients();

    await replyToMessage(
      clients,
      "15550001111",
      "wamid.TARGET1",
      asRichlink({ url: "https://example.com/post" })
    );

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      replyTo: "wamid.TARGET1",
      text: { body: "https://example.com/post", previewUrl: true },
    });
  });
});
