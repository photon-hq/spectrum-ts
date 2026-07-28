import type {
  AdvancedIMessage,
  MessageEvent,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage/grpc";
import { describe, expect, it, vi } from "vitest";
import { MessageCache } from "@/cache";
import { toReadReceiptMessages } from "@/remote/read-receipts";
import type { IMessageMessage } from "@/types";

const SENT_DATE = new Date(1_700_000_000_000);
const READ_DATE = new Date(1_700_000_600_000);
const PHONE = "+15551234567";

type ReadEvent = Extract<MessageEvent, { type: "message.read" }>;

// Default `isFromMe: true` — the message the peer read is one we sent, which
// is exactly the target a genuine receipt points at.
const sdkMessage = (overrides: Partial<SDKMessage> = {}): SDKMessage =>
  ({
    guid: "msg-guid",
    chatGuids: ["s1"],
    content: {
      attachments: [],
      formatting: [],
      mentions: [],
      text: "from the bot",
    },
    dateCreated: SENT_DATE,
    isFromMe: true,
    sender: { address: PHONE },
    ...overrides,
  }) as unknown as SDKMessage;

const readEvent = (overrides: Partial<ReadEvent> = {}): ReadEvent =>
  ({
    actor: { address: "user@example.com" },
    chatGuid: "s1",
    isFromMe: true,
    messageGuid: "msg-guid",
    occurredAt: SENT_DATE,
    readAt: READ_DATE,
    sequence: 1,
    type: "message.read",
    ...overrides,
  }) as unknown as ReadEvent;

const remoteWith = (get: (message: string) => Promise<SDKMessage>) =>
  ({ messages: { get: vi.fn(get) } }) as unknown as AdvancedIMessage;

const getMock = (remote: AdvancedIMessage) =>
  remote.messages.get as unknown as ReturnType<typeof vi.fn>;

describe("iMessage remote toReadReceiptMessages", () => {
  it("emits a read receipt with the reader as sender and our message as target", async () => {
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent(),
      PHONE
    );

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.id).toBe("msg-guid:read:1");
    expect(message?.sender?.id).toBe("user@example.com");
    expect(message?.space).toEqual({ id: "s1", type: "dm", phone: PHONE });
    expect(message?.content.type).toBe("read");
    if (message?.content.type === "read") {
      expect(message.content.target.id).toBe("msg-guid");
      expect(message.content.target.direction).toBe("outbound");
    }
  });

  it("carries the actor's address, country, and service onto the reader", async () => {
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent({
        actor: {
          address: "+15557654321",
          country: "ca",
          service: "iMessage",
        },
      } as Partial<ReadEvent>),
      PHONE
    );

    expect(messages[0]?.sender).toEqual({
      id: "+15557654321",
      address: "+15557654321",
      country: "ca",
      service: "iMessage",
    });
  });

  it("uses readAt, not occurredAt, for the timestamp", async () => {
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent(),
      PHONE
    );

    // The whole value of a receipt is *when* it was read. `occurredAt` is when
    // the bridge observed the event, which lags on Continuity sync.
    expect(messages[0]?.timestamp).toEqual(READ_DATE);
    expect(messages[0]?.timestamp).not.toEqual(SENT_DATE);
  });

  it("falls back to occurredAt when readAt is absent", async () => {
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent({ readAt: undefined } as Partial<ReadEvent>),
      PHONE
    );

    expect(messages[0]?.timestamp).toEqual(SENT_DATE);
  });

  it("recovers the reader from the DM chat guid when the actor is our own line", async () => {
    // Real-line shape (ENG-2101): on `message.read` the platform reports
    // `actor` as *our own* line even when the peer did the reading. Trusting
    // it would attribute every DM receipt to ourselves.
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent({
        actor: { address: PHONE },
        chatGuid: "any;-;+15559998888",
      } as Partial<ReadEvent>),
      PHONE
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sender).toEqual({
      id: "+15559998888",
      address: "+15559998888",
    });
  });

  it("recovers the reader from the DM chat guid when there is no actor", async () => {
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent({
        actor: undefined,
        chatGuid: "any;-;+15559998888",
      } as Partial<ReadEvent>),
      PHONE
    );

    expect(messages[0]?.sender?.id).toBe("+15559998888");
  });

  it("drops a group receipt with no identifiable reader", async () => {
    // A group guid carries no participant list, so an actor of our own line
    // leaves the reader unknown — and the reader is the whole payload.
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent({
        actor: { address: PHONE },
        chatGuid: "iMessage;+;chat9",
      } as Partial<ReadEvent>),
      PHONE
    );

    expect(messages).toEqual([]);
    // The reader guard must short-circuit before the RPC.
    expect(getMock(remote)).not.toHaveBeenCalled();
  });

  it("drops a receipt whose target is one of their inbound messages", async () => {
    // This is the echo of our own `chats.markRead()`: it marks *their*
    // messages, so the resolved target is inbound and must not surface.
    const remote = remoteWith(() =>
      Promise.resolve(sdkMessage({ isFromMe: false }))
    );

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent(),
      PHONE
    );

    expect(messages).toEqual([]);
  });

  it("emits regardless of isFromMe", async () => {
    // `isFromMe` is undocumented on this arm and most plausibly describes the
    // underlying message — ours, for a genuine receipt. Behavior must not
    // depend on it either way.
    for (const isFromMe of [true, false]) {
      const remote = remoteWith(() => Promise.resolve(sdkMessage()));

      const messages = await toReadReceiptMessages(
        remote,
        new MessageCache(),
        readEvent({ isFromMe } as Partial<ReadEvent>),
        PHONE
      );

      expect(messages).toHaveLength(1);
    }
  });

  it("drops the receipt when the target cannot be fetched", async () => {
    const remote = remoteWith(() => Promise.reject(new Error("gone")));

    const messages = await toReadReceiptMessages(
      remote,
      new MessageCache(),
      readEvent(),
      PHONE
    );

    expect(messages).toEqual([]);
  });

  it("resolves the target once and warms the cache for sibling receipts", async () => {
    const remote = remoteWith(() => Promise.resolve(sdkMessage()));
    const cache = new MessageCache();

    const first = await toReadReceiptMessages(
      remote,
      cache,
      readEvent({
        actor: { address: "a@example.com" },
        sequence: 1,
      } as Partial<ReadEvent>),
      PHONE
    );
    const second = await toReadReceiptMessages(
      remote,
      cache,
      readEvent({
        actor: { address: "b@example.com" },
        sequence: 2,
      } as Partial<ReadEvent>),
      PHONE
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Amplification is O(distinct messages read), not O(messages x readers).
    expect(getMock(remote)).toHaveBeenCalledTimes(1);
  });

  it("emits one message per participant in a group", async () => {
    const remote = remoteWith(() =>
      Promise.resolve(sdkMessage({ chatGuids: ["iMessage;+;chat123"] }))
    );
    const cache = new MessageCache();
    const readers = ["a@example.com", "b@example.com", "c@example.com"];

    const messages: IMessageMessage[] = [];
    for (const [index, address] of readers.entries()) {
      messages.push(
        ...(await toReadReceiptMessages(
          remote,
          cache,
          readEvent({
            actor: { address },
            chatGuid: "iMessage;+;chat123",
            sequence: index + 1,
          } as Partial<ReadEvent>),
          PHONE
        ))
      );
    }

    expect(messages).toHaveLength(3);
    expect(new Set(messages.map((m) => m.id)).size).toBe(3);
    expect(messages.map((m) => m.sender?.id)).toEqual(readers);
    for (const message of messages) {
      expect(message.space.type).toBe("group");
      if (message.content.type === "read") {
        expect(message.content.target.id).toBe("msg-guid");
      }
    }
  });
});
