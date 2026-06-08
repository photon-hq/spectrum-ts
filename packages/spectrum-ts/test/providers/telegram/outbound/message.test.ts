import { describe, expect, it } from "bun:test";
import { attachment } from "@/content/attachment";
import { contact } from "@/content/contact";
import { poll } from "@/content/poll";
import { reply } from "@/content/reply";
import { richlink } from "@/content/richlink";
import { text } from "@/content/text";
import type { Content } from "@/content/types";
import { voice } from "@/content/voice";
import { buildSend } from "@/providers/telegram/outbound/message";
import type { Message } from "@/types/message";

const target = {
  id: "42",
  content: { type: "text", text: "x" },
} as unknown as Message;

// `buildSend` is the pure content → Bot API method/params mapping. It does NOT
// inject `chat_id` (the caller does) or touch the network, so it is tested
// directly with no client.
describe("buildSend", () => {
  it("maps text to sendMessage", async () => {
    expect(await buildSend(await text("hi").build())).toEqual({
      method: "sendMessage",
      params: { text: "hi" },
    });
  });

  it("maps a richlink to sendMessage with the url (Telegram auto-unfurls)", async () => {
    expect(await buildSend(await richlink("https://x.test").build())).toEqual({
      method: "sendMessage",
      params: { text: "https://x.test" },
    });
  });

  it("maps an image attachment to sendPhoto under the photo field", async () => {
    const spec = await buildSend(
      await attachment(Buffer.from("img"), {
        mimeType: "image/png",
        name: "p.png",
      }).build()
    );
    expect(spec.method).toBe("sendPhoto");
    expect(spec.file?.field).toBe("photo");
    expect(spec.file?.filename).toBe("p.png");
    expect(spec.file?.mimeType).toBe("image/png");
  });

  it("maps a non-image attachment to sendDocument", async () => {
    const spec = await buildSend(
      await attachment(Buffer.from("d"), {
        mimeType: "application/pdf",
        name: "d.pdf",
      }).build()
    );
    expect(spec.method).toBe("sendDocument");
    expect(spec.file?.field).toBe("document");
  });

  it("maps voice to sendVoice", async () => {
    const spec = await buildSend(
      await voice(Buffer.from("a"), {
        mimeType: "audio/ogg",
        name: "v.ogg",
      }).build()
    );
    expect(spec.method).toBe("sendVoice");
    expect(spec.file?.field).toBe("voice");
    expect(spec.file?.filename).toBe("v.ogg");
  });

  it("maps a contact to a sendDocument vCard", async () => {
    const spec = await buildSend(
      await contact({ phones: [{ value: "+15551234567" }] }).build()
    );
    expect(spec.method).toBe("sendDocument");
    expect(spec.file?.field).toBe("document");
    expect(spec.file?.filename).toBe("contact.vcf");
  });

  it("threads a reply via reply_parameters around the inner spec", async () => {
    const spec = await buildSend(await reply("hey", target).build());
    expect(spec.method).toBe("sendMessage");
    expect(spec.params).toEqual({
      text: "hey",
      reply_parameters: { message_id: 42 },
    });
  });

  it("passes custom content straight to the named Bot API method", async () => {
    const custom = {
      type: "custom",
      raw: { method: "sendDice", params: { emoji: "🎲" } },
    } as unknown as Content;
    expect(await buildSend(custom)).toEqual({
      method: "sendDice",
      params: { emoji: "🎲" },
    });
  });

  it("throws UnsupportedError for content with no Bot API mapping", async () => {
    await expect(
      buildSend(await poll("Q?", "a", "b").build())
    ).rejects.toThrow();
  });
});
