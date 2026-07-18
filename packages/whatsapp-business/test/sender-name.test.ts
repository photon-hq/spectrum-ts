import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { describe, expect, it } from "vitest";
import { messages } from "@/messages";
import type { WhatsAppMessage } from "@/types";

// Drives the real inbound path — messages() -> clientStream -> toMessages —
// with a fake client whose event stream yields one message.
const fakeClient = (inbound: Record<string, unknown>): WhatsAppClient => {
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

const baseMessage = (overrides: Record<string, unknown>) => ({
  id: "wamid.NAME1",
  from: "15551234567",
  timestamp: new Date("2026-07-17T00:00:00.000Z"),
  content: { type: "text", body: "hello" },
  ...overrides,
});

describe("whatsapp inbound sender display name", () => {
  it("carries the profile push name on the sender", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({ contact: { waId: "15551234567", name: "Pratik Jain" } })
      )
    );

    expect(received?.sender).toEqual({
      id: "15551234567",
      name: "Pratik Jain",
    });
  });

  it("omits name when the contacts payload is absent", async () => {
    const received = await receiveOne(fakeClient(baseMessage({})));

    expect(received?.sender).toEqual({ id: "15551234567" });
  });

  it("carries the name onto captioned-media group items", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({
          content: {
            type: "image",
            media: {
              id: "983666494500094",
              mimeType: "image/jpeg",
              caption: "look",
            },
          },
          contact: { waId: "15551234567", name: "Pratik Jain" },
        })
      )
    );

    const content = received?.content;
    if (content?.type !== "group") {
      throw new Error(`expected group content, got ${content?.type}`);
    }
    for (const item of content.items) {
      expect(item.sender).toEqual({ id: "15551234567", name: "Pratik Jain" });
    }
  });
});
