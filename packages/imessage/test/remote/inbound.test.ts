import { describe, expect, it } from "bun:test";
import type {
  AdvancedIMessage,
  MessageEvent,
} from "@photon-ai/advanced-imessage";
import { MessageCache } from "@/cache";
import { toInboundMessages } from "@/remote/inbound";

type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;

const RECEIVED_AT = new Date(1_700_000_000_000);

// A plain text message never touches the client (no attachment download), so a
// bare stub is enough to exercise the sender-normalization path.
const client = {} as unknown as AdvancedIMessage;

const receivedEvent = (
  sender?: Record<string, unknown>,
  content?: Record<string, unknown>
): ReceivedEvent =>
  ({
    type: "message.received",
    sequence: 1,
    chatGuid: "s1",
    isFromMe: false,
    occurredAt: RECEIVED_AT,
    message: {
      guid: "msg-guid",
      chatGuids: ["s1"],
      content: {
        attachments: [],
        formatting: [],
        mentions: [],
        text: "hi",
        ...content,
      },
      dateCreated: RECEIVED_AT,
      isFromMe: false,
      sender,
    },
  }) as unknown as ReceivedEvent;

const inboundSender = async (sender?: Record<string, unknown>) => {
  const messages = await toInboundMessages(
    client,
    new MessageCache(),
    receivedEvent(sender),
    "+15550000000"
  );
  return messages[0]?.sender;
};

describe("iMessage remote toInboundMessages sender", () => {
  it("surfaces address, country, and service from an iMessage sender", async () => {
    expect(
      await inboundSender({
        address: "+15551234567",
        country: "us",
        service: "iMessage",
      })
    ).toEqual({
      id: "+15551234567",
      address: "+15551234567",
      country: "us",
      service: "iMessage",
    });
  });

  it("reports the SMS service for green-bubble senders and omits absent country", async () => {
    expect(
      await inboundSender({ address: "+15551234567", service: "SMS" })
    ).toEqual({
      id: "+15551234567",
      address: "+15551234567",
      service: "SMS",
    });
  });

  it("falls back to an empty id when the sender is absent", async () => {
    expect(await inboundSender(undefined)).toEqual({ id: "" });
  });
});

describe("iMessage remote toInboundMessages content", () => {
  it("surfaces a URL balloon as plain text rather than a rich link", async () => {
    const [message] = await toInboundMessages(
      client,
      new MessageCache(),
      receivedEvent(
        { address: "+15551234567" },
        {
          text: "https://example.com/post",
          balloonBundleId: "com.apple.messages.URLBalloonProvider",
        }
      ),
      "+15550000000"
    );
    expect(message?.content).toEqual({
      type: "text",
      text: "https://example.com/post",
    });
  });
});
