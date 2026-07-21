import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { messages, send } from "@/messages";
import type { WhatsAppClients } from "@/types";

// Drives the real inbound path — messages() -> clientStream — so the
// per-space inbound-wamid cache is populated exactly the way production
// populates it, then exercises the typing branch of send() on the same
// client instance (the cache is keyed by client object identity).
const fakeClient = (
  inbounds: unknown[],
  markRead: ReturnType<typeof vi.fn>
): WhatsAppClient => {
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
    messages: { markRead },
  } as unknown as WhatsAppClient;
};

const textEvent = (id: string, from: string) => ({
  id,
  from,
  timestamp: new Date("2026-07-20T00:00:00.000Z"),
  content: { type: "text", body: "hi" },
});

const drain = async (client: WhatsAppClient): Promise<void> => {
  for await (const _ of messages([client])) {
    // pump inbound so the wamid cache fills
  }
};

const typingContent = (state: "start" | "stop"): Content =>
  ({ type: "typing", state }) as Content;

describe("whatsapp send — typing", () => {
  it("anchors a typing indicator to the newest inbound wamid", async () => {
    const markRead = vi.fn(() => Promise.resolve());
    const client = fakeClient(
      [
        textEvent("wamid.OLD", "15551234567"),
        textEvent("wamid.NEW", "15551234567"),
      ],
      markRead
    );
    await drain(client);

    const result = await send(
      [client] as unknown as WhatsAppClients,
      "15551234567",
      typingContent("start")
    );

    expect(result).toBeUndefined();
    expect(markRead).toHaveBeenCalledWith("wamid.NEW", {
      typingIndicator: true,
    });
  });

  it("no-ops when the space has no inbound message yet", async () => {
    const markRead = vi.fn(() => Promise.resolve());
    const client = fakeClient([textEvent("wamid.1", "15551234567")], markRead);
    await drain(client);

    await send(
      [client] as unknown as WhatsAppClients,
      "15550009999",
      typingContent("start")
    );

    expect(markRead).not.toHaveBeenCalled();
  });

  it("no-ops on typing stop (Meta auto-dismisses, no stop API)", async () => {
    const markRead = vi.fn(() => Promise.resolve());
    const client = fakeClient([textEvent("wamid.1", "15551234567")], markRead);
    await drain(client);

    await send(
      [client] as unknown as WhatsAppClients,
      "15551234567",
      typingContent("stop")
    );

    expect(markRead).not.toHaveBeenCalled();
  });

  it("swallows markRead failures — typing stays a best-effort hint", async () => {
    const markRead = vi.fn(() => Promise.reject(new Error("stale wamid")));
    const client = fakeClient([textEvent("wamid.1", "15551234567")], markRead);
    await drain(client);

    await expect(
      send(
        [client] as unknown as WhatsAppClients,
        "15551234567",
        typingContent("start")
      )
    ).resolves.toBeUndefined();
  });
});
