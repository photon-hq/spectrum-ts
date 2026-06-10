import { describe, expect, it, mock } from "bun:test";
import type {
  AdvancedIMessage,
  Message as SDKMessage,
  SettableMessageReaction,
} from "@photon-ai/advanced-imessage";
import { formatChildId } from "@/providers/imessage/remote/ids";
import { unsendReaction } from "@/providers/imessage/remote/reactions";
import { unsendMessage } from "@/providers/imessage/remote/send";
import type { IMessageMessage } from "@/providers/imessage/types";

const makeRemote = () => {
  const unsend = mock(
    (_chat: string, _message: string, _options?: { partIndex?: number }) =>
      Promise.resolve()
  );
  const tapback = {
    guid: "tapback-1",
    dateCreated: new Date(0),
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
    messages: { setReaction, unsend },
  } as unknown as AdvancedIMessage;
  return { remote, setReaction, unsend };
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

describe("iMessage remote unsendMessage", () => {
  it("retracts by chat and message guid", async () => {
    const { remote, unsend } = makeRemote();
    await unsendMessage(remote, "s1", "msg-guid");

    expect(unsend).toHaveBeenCalledTimes(1);
    const [chat, message, options] = unsend.mock.calls[0] ?? [];
    expect(chat).toBe("s1");
    expect(message).toBe("msg-guid");
    expect(options).toBeUndefined();
  });

  it("unwraps child ids and forwards partIndex", async () => {
    const { remote, unsend } = makeRemote();
    await unsendMessage(remote, "s1", formatChildId(2, "parent-guid"));

    const [, message, options] = unsend.mock.calls[0] ?? [];
    expect(message).toBe("parent-guid");
    expect(options).toEqual({ partIndex: 2 });
  });

  it("propagates SDK rejections (expired window, double unsend)", async () => {
    const unsend = mock(() =>
      Promise.reject(new Error("unsend window expired"))
    );
    const remote = { messages: { unsend } } as unknown as AdvancedIMessage;

    await expect(unsendMessage(remote, "s1", "msg-guid")).rejects.toThrow(
      "unsend window expired"
    );
  });
});

describe("iMessage remote unsendReaction", () => {
  it("removes a native tapback with isSet=false", async () => {
    const { remote, setReaction } = makeRemote();
    await unsendReaction(remote, "s1", target(), "👍");

    expect(setReaction).toHaveBeenCalledTimes(1);
    const [chat, message, reaction, isSet] = setReaction.mock.calls[0] ?? [];
    expect(chat).toBe("s1");
    expect(message).toBe("msg-guid");
    expect(reaction).toEqual({ kind: "like" });
    expect(isSet).toBe(false);
  });

  it("falls back to an emoji reaction for non-tapback emoji", async () => {
    const { remote, setReaction } = makeRemote();
    await unsendReaction(remote, "s1", target(), "🦊");

    const [, , reaction, isSet] = setReaction.mock.calls[0] ?? [];
    expect(reaction).toEqual({ kind: "emoji", emoji: "🦊" });
    expect(isSet).toBe(false);
  });

  it("targets the parent guid and forwards partIndex for group parts", async () => {
    const { remote, setReaction } = makeRemote();
    await unsendReaction(
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
