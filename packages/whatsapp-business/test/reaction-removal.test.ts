import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { describe, expect, it } from "vitest";
import { messages } from "@/messages";
import type { WhatsAppMessage } from "@/types";

// Drives the real inbound path — messages() -> clientStream -> toMessages —
// with a fake client whose event stream yields the given raw messages.
// Meta represents removing a reaction as a reaction event whose emoji is the
// protobuf default "" — before this fix that threw a ZodError inside the
// stream pump and killed the project's entire messages stream (2026-07-16
// production incident).
const fakeClient = (inbounds: unknown[]): WhatsAppClient => {
  const filtered = {
    async *[Symbol.asyncIterator]() {
      for (const inbound of inbounds) {
        yield { type: "message", message: inbound };
      }
    },
    close: async () => undefined,
  };
  return {
    events: { subscribe: () => ({ filter: () => filtered }) },
  } as unknown as WhatsAppClient;
};

const reactionEvent = (emoji: string) => ({
  id: "wamid.REACT1",
  from: "15551234567",
  timestamp: new Date("2026-07-16T00:00:00.000Z"),
  content: {
    type: "reaction",
    reaction: { messageId: "wamid.TARGET1", emoji },
  },
});

const textEvent = (id: string, body: string) => ({
  id,
  from: "15551234567",
  timestamp: new Date("2026-07-16T00:00:00.000Z"),
  content: { type: "text", body },
});

const receiveAll = async (
  client: WhatsAppClient
): Promise<WhatsAppMessage[]> => {
  const received: WhatsAppMessage[] = [];
  for await (const m of messages([client])) {
    received.push(m);
  }
  return received;
};

describe("whatsapp reaction removal", () => {
  it("surfaces an emoji reaction as reaction content", async () => {
    const [received] = await receiveAll(
      fakeClient([reactionEvent("\u{1F44D}")])
    );

    expect(received?.content).toMatchObject({
      type: "reaction",
      emoji: "\u{1F44D}",
    });
  });

  it("surfaces an empty-emoji reaction (removal) as a custom arm, not a throw", async () => {
    const [received] = await receiveAll(fakeClient([reactionEvent("")]));

    expect(received?.content).toMatchObject({
      type: "custom",
      raw: {
        whatsapp_type: "reaction-removed",
        messageId: "wamid.TARGET1",
      },
    });
  });

  it("keeps the stream alive when one event is unmappable", async () => {
    // An event whose content shape crashes toMessages entirely (media with
    // no payload) must be skipped — the messages after it still flow.
    const poison = {
      id: "wamid.POISON1",
      from: "15551234567",
      timestamp: new Date("2026-07-16T00:00:00.000Z"),
      content: { type: "image" },
    };

    const received = await receiveAll(
      fakeClient([poison, textEvent("wamid.OK1", "still alive")])
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("wamid.OK1");
    expect(received[0]?.content).toMatchObject({
      type: "text",
      text: "still alive",
    });
  });
});
