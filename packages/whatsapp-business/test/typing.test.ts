import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { typing } from "@spectrum-ts/core";
import { collectUntilIdle } from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
import { messages, send } from "@/messages";

// Meta's typing indicator rides on mark-as-read and must name an inbound
// wamid, so these drive the real inbound path first — messages() ->
// clientStream — to seed the latest-inbound cache, then send `typing`.
const USER = "15551234567";

const fakeClient = (
  inbounds: unknown[],
  markRead = vi.fn(() => Promise.resolve())
) => {
  const filtered = {
    async *[Symbol.asyncIterator]() {
      for (const inbound of inbounds) {
        yield { type: "message", message: inbound };
      }
    },
    close: async () => undefined,
  };
  const client = {
    events: { subscribe: () => ({ filter: () => filtered }) },
    messages: { markRead },
  } as unknown as WhatsAppClient;
  return { client, markRead };
};

const textEvent = (id: string, at: string, from = USER) => ({
  id,
  from,
  timestamp: new Date(at),
  content: { type: "text", body: "hi" },
});

const reactionEvent = (id: string, at: string) => ({
  id,
  from: USER,
  timestamp: new Date(at),
  content: {
    type: "reaction",
    reaction: { messageId: "wamid.TEXT1", emoji: "\u{1F44D}" },
  },
});

const systemEvent = (id: string, at: string) => ({
  id,
  from: USER,
  timestamp: new Date(at),
  content: { type: "system", system: { body: "number changed" } },
});

const sendTyping = async (
  client: WhatsAppClient | WhatsAppClient[],
  state: "start" | "stop" = "start",
  spaceId = USER
) =>
  await send(
    Array.isArray(client) ? client : [client],
    spaceId,
    await typing(state).build()
  );

describe("whatsapp send — typing", () => {
  it("marks the latest inbound message read with a typing indicator", async () => {
    const { client, markRead } = fakeClient([
      textEvent("wamid.TEXT1", "2026-10-08T00:00:00.000Z"),
      textEvent("wamid.TEXT2", "2026-10-08T00:00:01.000Z"),
    ]);
    await collectUntilIdle(messages([client]));

    const result = await sendTyping(client);

    expect(result).toBeUndefined();
    expect(markRead).toHaveBeenCalledWith("wamid.TEXT2", {
      typingIndicator: true,
    });
  });

  it("keeps the newer message when gap-fill replays an older one", async () => {
    const { client, markRead } = fakeClient([
      textEvent("wamid.TEXT2", "2026-10-08T00:00:01.000Z"),
      textEvent("wamid.TEXT1", "2026-10-08T00:00:00.000Z"),
    ]);
    await collectUntilIdle(messages([client]));

    await sendTyping(client);

    expect(markRead).toHaveBeenCalledWith("wamid.TEXT2", {
      typingIndicator: true,
    });
  });

  it("does not anchor on reactions or system events", async () => {
    const { client, markRead } = fakeClient([
      textEvent("wamid.TEXT1", "2026-10-08T00:00:00.000Z"),
      reactionEvent("wamid.REACT1", "2026-10-08T00:00:01.000Z"),
      systemEvent("wamid.SYS1", "2026-10-08T00:00:02.000Z"),
    ]);
    await collectUntilIdle(messages([client]));

    await sendTyping(client);

    expect(markRead).toHaveBeenCalledWith("wamid.TEXT1", {
      typingIndicator: true,
    });
  });

  it("matches a space id written with a leading +", async () => {
    const { client, markRead } = fakeClient([
      textEvent("wamid.TEXT1", "2026-10-08T00:00:00.000Z"),
    ]);
    await collectUntilIdle(messages([client]));

    await sendTyping(client, "start", `+${USER}`);

    expect(markRead).toHaveBeenCalledWith("wamid.TEXT1", {
      typingIndicator: true,
    });
  });

  it("shows typing from the line that received the latest message", async () => {
    const first = fakeClient([
      textEvent("wamid.LINE1", "2026-10-08T00:00:00.000Z"),
    ]);
    const second = fakeClient([
      textEvent("wamid.LINE2", "2026-10-08T00:00:01.000Z"),
    ]);
    await collectUntilIdle(messages([first.client, second.client]));

    await sendTyping([first.client, second.client]);

    expect(first.markRead).not.toHaveBeenCalled();
    expect(second.markRead).toHaveBeenCalledWith("wamid.LINE2", {
      typingIndicator: true,
    });
  });

  it("no-ops when the user has not messaged in", async () => {
    const { client, markRead } = fakeClient([
      textEvent("wamid.OTHER", "2026-10-08T00:00:00.000Z", "15559990000"),
    ]);
    await collectUntilIdle(messages([client]));

    await sendTyping(client);

    expect(markRead).not.toHaveBeenCalled();
  });

  it("no-ops on stop, since Meta has no call to dismiss the bubble", async () => {
    const { client, markRead } = fakeClient([
      textEvent("wamid.TEXT1", "2026-10-08T00:00:00.000Z"),
    ]);
    await collectUntilIdle(messages([client]));

    await sendTyping(client, "stop");

    expect(markRead).not.toHaveBeenCalled();
  });

  it("does not let a Meta failure reach responding()", async () => {
    const markRead = vi.fn(() => Promise.reject(new Error("message too old")));
    const { client } = fakeClient(
      [textEvent("wamid.TEXT1", "2026-10-08T00:00:00.000Z")],
      markRead
    );
    await collectUntilIdle(messages([client]));

    await expect(sendTyping(client)).resolves.toBeUndefined();
    expect(markRead).toHaveBeenCalledOnce();
  });
});
