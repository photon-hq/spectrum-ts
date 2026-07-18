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
  id: "wamid.REPLY1",
  from: "15551234567",
  timestamp: new Date("2026-07-17T00:00:00.000Z"),
  content: { type: "text", body: "check this out?" },
  ...overrides,
});

describe("whatsapp inbound quoted-reply context", () => {
  it("wraps a quoted text message in reply content with a stub target", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({
          context: { id: "wamid.QUOTED1", from: "15550001111" },
        })
      )
    );

    expect(received?.content).toMatchObject({
      type: "reply",
      content: { type: "text", text: "check this out?" },
      target: {
        id: "wamid.QUOTED1",
        content: {
          type: "custom",
          raw: { whatsapp_type: "reply-target", stub: true },
        },
      },
    });
  });

  it("leaves a message without context unwrapped", async () => {
    const received = await receiveOne(fakeClient(baseMessage({})));

    expect(received?.content).toMatchObject({
      type: "text",
      text: "check this out?",
    });
  });

  it("wraps quoted captioned media as a reply around the group", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({
          content: {
            type: "image",
            media: {
              id: "983666494500094",
              mimeType: "image/jpeg",
              caption: "this one?",
            },
          },
          context: { id: "wamid.QUOTED2" },
        })
      )
    );

    const content = received?.content;
    if (content?.type !== "reply") {
      throw new Error(`expected reply content, got ${content?.type}`);
    }
    expect(content.target.id).toBe("wamid.QUOTED2");
    expect(content.content).toMatchObject({ type: "group" });
  });

  it("wraps a quoted contact card share", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({
          content: {
            type: "contacts",
            contacts: [
              {
                name: { formattedName: "Pratik Jain" },
                phones: [],
                emails: [],
                addresses: [],
                urls: [],
              },
            ],
          },
          context: { id: "wamid.QUOTED3" },
        })
      )
    );

    expect(received?.content).toMatchObject({
      type: "reply",
      content: { type: "contact" },
      target: { id: "wamid.QUOTED3" },
    });
  });

  it("does not wrap interactive replies — their context references the tapped message", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({
          content: {
            type: "interactive",
            interactive: {
              type: "button_reply",
              reply: { id: "opt_0", title: "Yes" },
            },
          },
          context: { id: "wamid.INTERACTIVE1" },
        })
      )
    );

    expect(received?.content).toMatchObject({
      type: "custom",
      raw: { whatsapp_type: "interactive" },
    });
  });

  it("keeps the stream alive when a context-carrying event is unmappable", async () => {
    // A quoted-reply event whose content crashes mapping (media with no
    // payload) must be skipped by the poison-event guard — the messages
    // after it still flow, reply-wrapped as usual.
    const poison = baseMessage({
      content: { type: "image" },
      context: { id: "wamid.QUOTEDX" },
    });
    const good = baseMessage({
      id: "wamid.OK1",
      context: { id: "wamid.QUOTED9" },
    });
    const filtered = {
      async *[Symbol.asyncIterator]() {
        yield { type: "message", message: poison };
        yield { type: "message", message: good };
      },
      close: async () => undefined,
    };
    const client = {
      events: { subscribe: () => ({ filter: () => filtered }) },
    } as unknown as WhatsAppClient;

    const received: WhatsAppMessage[] = [];
    for await (const m of messages([client])) {
      received.push(m);
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("wamid.OK1");
    expect(received[0]?.content).toMatchObject({
      type: "reply",
      target: { id: "wamid.QUOTED9" },
    });
  });

  it("does not wrap reaction events", async () => {
    const received = await receiveOne(
      fakeClient(
        baseMessage({
          content: {
            type: "reaction",
            reaction: { messageId: "wamid.REACTED1", emoji: "👍" },
          },
          context: { id: "wamid.REACTED1" },
        })
      )
    );

    expect(received?.content).toMatchObject({ type: "reaction" });
  });
});
