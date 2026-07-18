import type { WhatsAppClient } from "@photon-ai/whatsapp-business";
import { describe, expect, it } from "vitest";
import { messages } from "@/messages";
import type { WhatsAppMessage } from "@/types";

// Drives the real inbound path — messages() -> clientStream -> toMessages —
// with a fake client whose event stream yields one audio message.
const fakeAudioClient = (media: {
  id: string;
  mimeType: string;
  voice?: boolean;
}): WhatsAppClient => {
  const inbound = {
    id: "wamid.AUDIO1",
    from: "15551234567",
    timestamp: new Date("2026-07-17T00:00:00.000Z"),
    content: { type: "audio", media },
  };
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

describe("whatsapp inbound voice notes", () => {
  it("classifies a PTT recording (media.voice) as voice content", async () => {
    const received = await receiveOne(
      fakeAudioClient({
        id: "983666494500094",
        mimeType: "audio/ogg; codecs=opus",
        voice: true,
      })
    );

    expect(received?.content).toMatchObject({
      type: "voice",
      id: "983666494500094",
      mimeType: "audio/ogg; codecs=opus",
    });
  });

  it("keeps a plain audio file as an attachment", async () => {
    const received = await receiveOne(
      fakeAudioClient({ id: "983666494500094", mimeType: "audio/mpeg" })
    );

    expect(received?.content).toMatchObject({
      type: "attachment",
      id: "983666494500094",
      mimeType: "audio/mpeg",
    });
  });
});
