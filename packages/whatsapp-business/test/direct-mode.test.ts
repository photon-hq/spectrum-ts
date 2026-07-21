import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { Spectrum } from "@spectrum-ts/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  close: vi.fn(),
  createClient: vi.fn(),
  send: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@photon-ai/whatsapp-business", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@photon-ai/whatsapp-business")>()),
  createClient: sdk.createClient,
}));

import { whatsappBusiness } from "@/index";

// Minimal stand-in for the SDK's `events.subscribe()` result: an immediately
// completed async iterable that also satisfies the `.filter()` / `.close()`
// calls the provider makes on it.
const fakeEventStream = () => {
  const eventStream = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
    close: () => Promise.resolve(),
    filter: () => eventStream,
  };
  return eventStream;
};

const drain = async (source: AsyncIterable<unknown>): Promise<unknown[]> => {
  const output: unknown[] = [];
  for await (const value of source) {
    output.push(value);
  }
  return output;
};

describe("whatsapp direct-mode lifecycle", () => {
  beforeEach(() => {
    sdk.close.mockReset().mockResolvedValue(undefined);
    sdk.send
      .mockReset()
      .mockResolvedValue({ messageId: "wamid.sent", messageStatus: "sent" });
    sdk.subscribe.mockReset().mockImplementation(fakeEventStream);
    sdk.createClient.mockReset().mockImplementation(
      () =>
        ({
          close: sdk.close,
          events: { subscribe: sdk.subscribe },
          media: {},
          messages: { send: sdk.send },
          [Symbol.asyncDispose]: sdk.close,
        }) as unknown as WhatsAppClient
    );
  });

  it("keeps outbound-only send-capable without opening an inbound subscribe", async () => {
    const app = await Spectrum({
      providers: [
        whatsappBusiness.config({
          mode: "outbound-only",
          accessToken: "direct-token",
          phoneNumberId: "direct-phone",
        }),
      ],
    });

    try {
      expect(sdk.createClient).toHaveBeenCalledWith({
        accessToken: "direct-token",
        appSecret: "",
        phoneNumberId: "direct-phone",
      });
      await expect(drain(app.messages)).resolves.toEqual([]);
      expect(sdk.subscribe).not.toHaveBeenCalled();

      const space = await whatsappBusiness(app).space.create("15551234567");
      const sent = await space.send("hello");
      expect(sdk.send).toHaveBeenCalledWith({
        to: "15551234567",
        text: "hello",
      });
      expect(sent?.id).toBe("wamid.sent");
    } finally {
      await app.stop();
    }

    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it("passes appSecret through and subscribes in inbound mode", async () => {
    const app = await Spectrum({
      providers: [
        whatsappBusiness.config({
          mode: "inbound",
          accessToken: "direct-token",
          phoneNumberId: "direct-phone",
          appSecret: "direct-secret",
        }),
      ],
    });

    try {
      expect(sdk.createClient).toHaveBeenCalledWith({
        accessToken: "direct-token",
        appSecret: "direct-secret",
        phoneNumberId: "direct-phone",
      });
      await drain(app.messages);
      expect(sdk.subscribe).toHaveBeenCalledOnce();
    } finally {
      await app.stop();
    }
  });
});
