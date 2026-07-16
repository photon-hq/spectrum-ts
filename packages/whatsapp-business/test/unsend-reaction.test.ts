import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import type { Content } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { send } from "@/messages";

// Meta's Cloud API retracts a reaction by re-sending it with emoji: "" at the
// reacted message. Regular business messages cannot be deleted, so unsend is
// supported for reaction messages only.

const UNSEND_UNSUPPORTED = /unsend/;

const fakeSendClient = () => {
  const sendMock = vi.fn(async () => ({ messageId: "wamid.NEW" }));
  const client = {
    messages: { send: sendMock },
  } as unknown as WhatsAppClient;
  return { client, sendMock };
};

const unsendOf = (targetContent: unknown): Content =>
  ({
    type: "unsend",
    target: {
      id: "wamid.SENT1",
      direction: "outbound",
      content: targetContent,
    },
  }) as unknown as Content;

describe("whatsapp outbound unsend", () => {
  it("retracts a reaction by sending an empty emoji at the reacted message", async () => {
    const { client, sendMock } = fakeSendClient();

    const result = await send(
      [client],
      "15551234567",
      unsendOf({
        type: "reaction",
        emoji: "\u{1F44D}",
        // Synthetic group-item suffix must be stripped for the Cloud API.
        target: {
          id: "wamid.TARGET1:0",
          content: { type: "text", text: "hi" },
        },
      })
    );

    expect(result).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      to: "15551234567",
      reaction: { messageId: "wamid.TARGET1", emoji: "" },
    });
  });

  it("rejects unsend of a non-reaction message as unsupported", async () => {
    const { client, sendMock } = fakeSendClient();

    await expect(
      send([client], "15551234567", unsendOf({ type: "text", text: "oops" }))
    ).rejects.toThrow(UNSEND_UNSUPPORTED);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
