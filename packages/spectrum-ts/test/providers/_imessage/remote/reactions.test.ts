import { describe, expect, it, mock } from "bun:test";
import type {
  AdvancedIMessage,
  Message as SDKMessage,
  SettableMessageReaction,
} from "@photon-ai/advanced-imessage";
import { reactToMessage } from "@/providers/imessage/remote/reactions";
import type { IMessageMessage } from "@/providers/imessage/types";

const SENT_DATE = new Date(1_700_000_000_000);

const makeRemote = () => {
  const tapback = {
    guid: "tapback-1",
    dateCreated: SENT_DATE,
  } as unknown as SDKMessage;
  const setReaction = mock(
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
