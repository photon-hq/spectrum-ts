import { describe, expect, it, mock } from "bun:test";
import type { Message } from "@spectrum-ts/core";
import { asRead } from "@spectrum-ts/core/authoring";
import { send } from "@/messages";
import type { WhatsAppClients } from "@/types";

const target = {
  id: "wamid.123",
  content: { type: "text", text: "hi" },
  direction: "inbound",
} as unknown as Message;

describe("whatsapp send — read", () => {
  it("marks the conversation read up to the target via markRead", async () => {
    const markRead = mock(() => Promise.resolve());
    const clients = [{ messages: { markRead } }] as unknown as WhatsAppClients;

    const result = await send(clients, "15550001111", asRead({ target }));

    // Fire-and-forget: no record, and the Cloud API receives the wamid of
    // the message being acknowledged (it marks all earlier ones too).
    expect(result).toBeUndefined();
    expect(markRead).toHaveBeenCalledWith("wamid.123");
  });
});
