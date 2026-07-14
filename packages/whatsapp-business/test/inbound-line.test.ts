import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { messages, send } from "@/messages";
import type { LineClient, WhatsAppMessage } from "@/types";

// Drives the real inbound path — messages() -> clientStream -> toMessages —
// with a fake client whose event stream yields one text message.
const fakeInboundClient = (from: string): LineClient["client"] => {
  const inbound = {
    id: `wamid.${from}`,
    from,
    timestamp: new Date("2026-07-13T00:00:00.000Z"),
    content: { type: "text", body: "hello" },
  };
  // `.filter(...)` result: an async-iterable with `close()`, matching what
  // clientStream consumes.
  const filtered = {
    async *[Symbol.asyncIterator]() {
      yield { type: "message", message: inbound };
    },
    close: async () => undefined,
  };
  return {
    events: { subscribe: () => ({ filter: () => filtered }) },
  } as unknown as LineClient["client"];
};

const receiveOne = async (
  entries: LineClient[]
): Promise<WhatsAppMessage | undefined> => {
  for await (const m of messages(entries)) {
    return m;
  }
  return;
};

const fakeSendClient = () => {
  const sendMock = vi.fn(async () => ({ messageId: "wamid.out" }));
  const client = {
    messages: { send: sendMock, markRead: vi.fn(async () => undefined) },
  } as unknown as LineClient["client"];
  return { client, sendMock };
};

const text: Content = { type: "text", text: "yo" } as Content;

describe("whatsapp space.line", () => {
  it("tags the inbound space with the client's line", async () => {
    const received = await receiveOne([
      { client: fakeInboundClient("15551234567"), line: "PHONE_NUMBER_ID_123" },
    ]);
    expect(received?.space.id).toBe("15551234567");
    expect(received?.space.line).toBe("PHONE_NUMBER_ID_123");
  });

  it("tags each client's messages with its own line", async () => {
    const seen = new Map<string, string | undefined>();
    const entries: LineClient[] = [
      { client: fakeInboundClient("15551110000"), line: "LINE_A" },
      { client: fakeInboundClient("15552220000"), line: "LINE_B" },
    ];
    for await (const m of messages(entries)) {
      seen.set(m.space.id, m.space.line);
      if (seen.size === 2) {
        break;
      }
    }
    expect(seen.get("15551110000")).toBe("LINE_A");
    expect(seen.get("15552220000")).toBe("LINE_B");
  });

  it("routes outbound to the client matching space.line", async () => {
    const a = fakeSendClient();
    const b = fakeSendClient();
    const clients: LineClient[] = [
      { client: a.client, line: "LINE_A" },
      { client: b.client, line: "LINE_B" },
    ];

    const record = await send(clients, "15551234567", text, "LINE_B");

    expect(b.sendMock).toHaveBeenCalledWith({
      to: "15551234567",
      text: "yo",
    });
    expect(a.sendMock).not.toHaveBeenCalled();
    expect(record?.space).toEqual({ id: "15551234567", line: "LINE_B" });
  });

  it("falls back to the first line when space.line is absent or unknown", async () => {
    const a = fakeSendClient();
    const b = fakeSendClient();
    const clients: LineClient[] = [
      { client: a.client, line: "LINE_A" },
      { client: b.client, line: "LINE_B" },
    ];

    const untagged = await send(clients, "15551234567", text);
    const unknown = await send(clients, "15551234567", text, "LINE_GONE");

    expect(a.sendMock).toHaveBeenCalledTimes(2);
    expect(b.sendMock).not.toHaveBeenCalled();
    expect(untagged?.space.line).toBe("LINE_A");
    expect(unknown?.space.line).toBe("LINE_A");
  });
});
