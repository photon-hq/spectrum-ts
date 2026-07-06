import type {
  AdvancedIMessage,
  MessageEvent,
  Message as SDKMessage,
  SettableMessageReaction,
} from "@photon-ai/advanced-imessage";
import { text } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { getMessageCache, MessageCache } from "@/cache";
import { imessage } from "@/index";
import { reactToMessage, toReactionMessages } from "@/remote/reactions";
import type { IMessageMessage } from "@/types";

const SENT_DATE = new Date(1_700_000_000_000);

const makeRemote = () => {
  const tapback = {
    guid: "tapback-1",
    dateCreated: SENT_DATE,
  } as unknown as SDKMessage;
  const setReaction = vi.fn(
    (
      _chat: string,
      _message: string,
      _reaction: SettableMessageReaction,
      _isSet: boolean,
      _options?: { partIndex?: number }
    ) => Promise.resolve(tapback)
  );
  const remote = {
    messages: { setReaction },
  } as unknown as AdvancedIMessage;
  return { remote, setReaction };
};

const target = (overrides: Partial<IMessageMessage> = {}): IMessageMessage =>
  ({
    id: "msg-guid",
    content: { type: "text", text: "hi" },
    sender: { id: "u1" },
    space: { id: "s1", type: "dm", phone: "+1" },
    timestamp: new Date(0),
    ...overrides,
  }) as unknown as IMessageMessage;

async function* fromArray(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

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
    sender: { address: "+15551234567" },
    ...overrides,
  }) as unknown as SDKMessage;

const attachment = (
  guid: string,
  fileName: string,
  mimeType: string
): SDKMessage["content"]["attachments"][number] =>
  ({
    fileName,
    guid,
    isHidden: false,
    isOutgoing: false,
    isSticker: false,
    mimeType,
    totalBytes: 123,
    transferState: "finished",
    uti: undefined,
  }) as unknown as SDKMessage["content"]["attachments"][number];

const reactionEvent = (
  overrides: Partial<
    Extract<MessageEvent, { type: "message.reactionAdded" }>
  > = {}
): Extract<MessageEvent, { type: "message.reactionAdded" }> =>
  ({
    actor: { address: "user@example.com" },
    chatGuid: "s1",
    isFromMe: false,
    messageGuid: "msg-guid",
    occurredAt: SENT_DATE,
    reaction: { kind: "like" },
    sequence: 1,
    type: "message.reactionAdded",
    ...overrides,
  }) as unknown as Extract<MessageEvent, { type: "message.reactionAdded" }>;

describe("iMessage remote reactToMessage", () => {
  it("maps a native tapback emoji and returns the tapback record", async () => {
    const { remote, setReaction } = makeRemote();
    const record = await reactToMessage(remote, "s1", target(), "👍");

    expect(setReaction).toHaveBeenCalledTimes(1);
    const [, , reaction, isSet] = setReaction.mock.calls[0] ?? [];
    expect(reaction).toEqual({ kind: "like" });
    expect(isSet).toBe(true);

    expect(record.id).toBe("tapback-1");
    expect(record.timestamp).toEqual(SENT_DATE);
    expect(record.space).toEqual({ id: "s1" });
    const content = record.content as { type: string; emoji: string };
    expect(content.type).toBe("reaction");
    expect(content.emoji).toBe("👍");
  });

  it("falls back to an emoji reaction for non-tapback emoji", async () => {
    const { remote, setReaction } = makeRemote();
    await reactToMessage(remote, "s1", target(), "🦊");

    const [, , reaction] = setReaction.mock.calls[0] ?? [];
    expect(reaction).toEqual({ kind: "emoji", emoji: "🦊" });
  });

  it("targets the parent guid and forwards partIndex for group parts", async () => {
    const { remote, setReaction } = makeRemote();
    await reactToMessage(
      remote,
      "s1",
      target({ parentId: "parent-guid", partIndex: 2 }),
      "👍"
    );

    const [, message, , , options] = setReaction.mock.calls[0] ?? [];
    expect(message).toContain("parent-guid");
    expect(options).toEqual({ partIndex: 2 });
  });
});

describe("iMessage remote toReactionMessages", () => {
  it("marks a fetched self-authored reaction target as outbound", async () => {
    const get = vi.fn((_message: string) => Promise.resolve(sdkMessage()));
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;

    const messages = await toReactionMessages(
      remote,
      new MessageCache(),
      reactionEvent(),
      "+15551234567"
    );

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.content.type).toBe("reaction");
    if (message?.content.type === "reaction") {
      expect(message.content.target.direction).toBe("outbound");
      expect(message.content.target.id).toBe("msg-guid");
    }
  });

  it("carries the actor's address, country, and service onto the reaction sender", async () => {
    const get = vi.fn((_message: string) => Promise.resolve(sdkMessage()));
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;

    const messages = await toReactionMessages(
      remote,
      new MessageCache(),
      reactionEvent({
        actor: {
          address: "+15557654321",
          country: "ca",
          service: "iMessage",
        },
      } as Partial<Extract<MessageEvent, { type: "message.reactionAdded" }>>),
      "+15551234567"
    );

    expect(messages[0]?.sender).toEqual({
      id: "+15557654321",
      address: "+15557654321",
      country: "ca",
      service: "iMessage",
    });
  });

  it("resolves tapbacks on a just-sent streamText message from the outbound cache", async () => {
    const sent = sdkMessage({ guid: "outbound-stream-guid" });
    const sendText = vi.fn((_chat: string, _text: string) =>
      Promise.resolve(sent)
    );
    const edit = vi.fn((_chat: string, _guid: string, _text: string) =>
      Promise.resolve(sent)
    );
    const get = vi.fn((_message: string) =>
      Promise.reject(new Error("message API has not caught up"))
    );
    const remote = {
      messages: { edit, get, sendText },
    } as unknown as AdvancedIMessage;
    const send = imessage.config().__definition.send;

    const record = await send({
      client: [{ client: remote, phone: "+15551234567" }],
      content: await text(fromArray(["hello"])).build(),
      space: {
        __platform: "iMessage",
        id: "s1",
        phone: "+15551234567",
        type: "dm",
      },
    });

    expect(record?.id).toBe("outbound-stream-guid");
    expect(sendText).toHaveBeenCalledTimes(1);

    const messages = await toReactionMessages(
      remote,
      getMessageCache(remote),
      reactionEvent({ messageGuid: "outbound-stream-guid" }),
      "+15551234567"
    );

    expect(get).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.content.type).toBe("reaction");
    if (message?.content.type === "reaction") {
      expect(message.content.target.direction).toBe("outbound");
      expect(message.content.target.id).toBe("outbound-stream-guid");
      expect(message.content.target.content).toEqual({
        text: "hello",
        type: "text",
      });
    }
  });

  it("resolves tapbacks to the ordered part inside an interleaved message", async () => {
    const get = vi.fn((_message: string) =>
      Promise.resolve(
        sdkMessage({
          content: {
            attachments: [
              attachment("att-0", "IMG_9151.png", "image/png"),
              attachment("att-1", "central.log", "application/octet-stream"),
              attachment("att-2", "IMG_8883.png", "image/png"),
            ],
            formatting: [],
            mentions: [],
            text: "before \uFFFC middle \uFFFC after \uFFFC done",
          },
          isFromMe: false,
          sender: { address: "+15550001111", service: "iMessage" },
        })
      )
    );
    const remote = {
      messages: { get },
    } as unknown as AdvancedIMessage;

    const messages = await toReactionMessages(
      remote,
      new MessageCache(),
      reactionEvent({ targetPartIndex: 5 }),
      "+15551234567"
    );

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.id).toBe("msg-guid:reaction:1:5");
    expect(message?.content.type).toBe("reaction");
    if (message?.content.type !== "reaction") {
      throw new Error("expected reaction content");
    }

    const targetMessage = message.content.target as unknown as IMessageMessage;
    expect(targetMessage.id).toBe("p:5/msg-guid");
    expect(targetMessage.parentId).toBe("msg-guid");
    expect(targetMessage.partIndex).toBe(5);
    expect(targetMessage.content.type).toBe("attachment");
    if (targetMessage.content.type === "attachment") {
      expect(targetMessage.content.id).toBe("att-2");
      expect(targetMessage.content.name).toBe("IMG_8883.png");
    }
  });
});
