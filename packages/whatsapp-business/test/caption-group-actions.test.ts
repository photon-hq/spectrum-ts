import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { Content, Message } from "@spectrum-ts/core";
import { asRead } from "@spectrum-ts/core/authoring";
import { describe, expect, it, vi } from "vitest";
import { send } from "@/messages";

// Group items carry synthetic ids (`<wamid>:<index>`); the Cloud API only
// knows the parent wamid, so targeted actions must strip the suffix.
const itemTarget = {
  id: "wamid.CAPTION1:1",
  content: { type: "text", text: "how many pieces left?" },
  direction: "inbound",
} as unknown as Message;

const fakeSendClient = () => {
  const sendMock = vi.fn(async () => ({ messageId: "wamid.out" }));
  const markRead = vi.fn(async () => undefined);
  const client = {
    messages: { send: sendMock, markRead },
  } as unknown as WhatsAppClient;
  return { client, sendMock, markRead };
};

describe("actions targeting captioned-media group items", () => {
  it("replies with the parent wamid, not the synthetic item id", async () => {
    const { client, sendMock } = fakeSendClient();
    const reply = {
      type: "reply",
      target: itemTarget,
      content: { type: "text", text: "three" },
    } as unknown as Content;

    await send([client], "15551234567", reply);

    expect(sendMock).toHaveBeenCalledWith({
      to: "15551234567",
      replyTo: "wamid.CAPTION1",
      text: "three",
    });
  });

  it("reacts with the parent wamid, not the synthetic item id", async () => {
    const { client, sendMock } = fakeSendClient();
    const reaction = {
      type: "reaction",
      target: itemTarget,
      emoji: "👍",
    } as unknown as Content;

    await send([client], "15551234567", reaction);

    expect(sendMock).toHaveBeenCalledWith({
      to: "15551234567",
      reaction: { messageId: "wamid.CAPTION1", emoji: "👍" },
    });
  });

  it("marks read with the parent wamid, not the synthetic item id", async () => {
    const { client, markRead } = fakeSendClient();

    await send([client], "15551234567", asRead({ target: itemTarget }));

    expect(markRead).toHaveBeenCalledWith("wamid.CAPTION1");
  });

  it("leaves plain wamids untouched", async () => {
    const { client, sendMock } = fakeSendClient();
    const reply = {
      type: "reply",
      target: { ...itemTarget, id: "wamid.PLAIN" },
      content: { type: "text", text: "ok" },
    } as unknown as Content;

    await send([client], "15551234567", reply);

    expect(sendMock).toHaveBeenCalledWith({
      to: "15551234567",
      replyTo: "wamid.PLAIN",
      text: "ok",
    });
  });
});
