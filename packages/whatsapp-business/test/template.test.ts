import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import {
  asWhatsAppTemplate,
  isWhatsAppTemplate,
  whatsappTemplate,
} from "@/content/template";
import { replyToMessage, send } from "@/messages";
import type { WhatsAppClients } from "@/types";

const fakeClients = () => {
  const sendSpy = vi.fn().mockResolvedValue({ messageId: "wamid.OUT1" });
  const clients = [
    { messages: { send: sendSpy } },
  ] as unknown as WhatsAppClients;
  return { clients, sendSpy };
};

describe("whatsapp template content", () => {
  it("builds tagged provider content", async () => {
    const built = await whatsappTemplate({
      name: "order_confirmation",
      languageCode: "en_US",
      bodyParams: ["Jessica"],
    }).build();

    expect(isWhatsAppTemplate(built)).toBe(true);
    expect(built).toMatchObject({
      type: "whatsapp-template",
      __platform: "WhatsApp Business",
    });
  });

  it("sends body params as text parameter objects with a flat languageCode", async () => {
    const { clients, sendSpy } = fakeClients();
    const template = asWhatsAppTemplate({
      name: "order_confirmation",
      languageCode: "en_US",
      bodyParams: ["Jessica", "#1042"],
    });

    const record = await send(
      clients,
      "15550001111",
      template as unknown as Content
    );

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      template: {
        name: "order_confirmation",
        languageCode: "en_US",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Jessica" },
              { type: "text", text: "#1042" },
            ],
          },
        ],
      },
    });
    expect(record).toMatchObject({ id: "wamid.OUT1" });
  });

  it("sends a no-variable template with empty components", async () => {
    const { clients, sendSpy } = fakeClients();

    await send(
      clients,
      "15550001111",
      asWhatsAppTemplate({
        name: "hello_world",
        languageCode: "en_US",
      }) as unknown as Content
    );

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      template: {
        name: "hello_world",
        languageCode: "en_US",
        components: [],
      },
    });
  });

  it("quotes the reply target on template replies", async () => {
    const { clients, sendSpy } = fakeClients();

    await replyToMessage(
      clients,
      "15550001111",
      "wamid.TARGET1",
      asWhatsAppTemplate({
        name: "hello_world",
        languageCode: "en_US",
      }) as unknown as Content
    );

    expect(sendSpy).toHaveBeenCalledWith({
      to: "15550001111",
      replyTo: "wamid.TARGET1",
      template: {
        name: "hello_world",
        languageCode: "en_US",
        components: [],
      },
    });
  });
});
