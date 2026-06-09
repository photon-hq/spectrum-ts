import { describe, expect, it, mock } from "bun:test";
import type {
  AdvancedIMessage,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  type StreamText,
  type StreamTextOptions,
  streamText,
} from "@/content/stream-text";
import { imessage } from "@/providers";
import { sendStreamText } from "@/providers/imessage/remote/stream-text";
import { UnsupportedError } from "@/utils/errors";

const SENT_DATE = new Date(1_700_000_000_000);
const BOOM = /boom/;
const LOCAL_MODE = /local mode/;

const makeRemote = () => {
  const reply = {
    guid: "msg-guid",
    dateCreated: SENT_DATE,
  } as unknown as SDKMessage;
  const sendText = mock((_chat: string, _text: string) =>
    Promise.resolve(reply)
  );
  const edit = mock((_chat: string, _guid: string, _text: string) =>
    Promise.resolve(reply)
  );
  const remote = {
    messages: { sendText, edit },
  } as unknown as AdvancedIMessage;
  return { remote, sendText, edit };
};

async function* fromArray(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

const content = async (
  items: string[],
  options?: StreamTextOptions
): Promise<StreamText> =>
  (await streamText(fromArray(items), options).build()) as StreamText;

// `editArgs` → the new-text argument of each edit call, in order.
const editArgs = (edit: ReturnType<typeof makeRemote>["edit"]): string[] =>
  edit.mock.calls.map((call) => call[2]);

describe("sendStreamText", () => {
  it("sends the first delta then flushes the full text on completion", async () => {
    const { remote, sendText, edit } = makeRemote();
    const result = await sendStreamText(
      remote,
      "chat",
      await content(["Hello", " ", "world"], { throttleMs: 10_000 })
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]).toEqual(["chat", "Hello"]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]).toEqual(["chat", "msg-guid", "Hello world"]);

    expect(result.id).toBe("msg-guid");
    expect(result.timestamp).toEqual(SENT_DATE);
    expect(result.content).toEqual({ type: "text", text: "Hello world" });
    expect(result.space).toEqual({ id: "chat" });
  });

  it("edits carry the cumulative full text (throttleMs: 0)", async () => {
    const { remote, sendText, edit } = makeRemote();
    await sendStreamText(
      remote,
      "chat",
      await content(["a", "b", "c"], { throttleMs: 0 })
    );

    expect(sendText.mock.calls[0]).toEqual(["chat", "a"]);
    expect(editArgs(edit)).toEqual(["ab", "abc"]);
  });

  it("buffers up to firstChunkChars before the first send", async () => {
    const { remote, sendText, edit } = makeRemote();
    await sendStreamText(
      remote,
      "chat",
      await content(["a", "b", "c", "d"], {
        firstChunkChars: 3,
        throttleMs: 10_000,
      })
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]).toEqual(["chat", "abc"]);
    expect(editArgs(edit)).toEqual(["abcd"]);
  });

  it("sends a single message and no edit when the stream ends below firstChunkChars", async () => {
    const { remote, sendText, edit } = makeRemote();
    const result = await sendStreamText(
      remote,
      "chat",
      await content(["hi"], { firstChunkChars: 10 })
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]).toEqual(["chat", "hi"]);
    expect(edit).not.toHaveBeenCalled();
    expect(result.content).toEqual({ type: "text", text: "hi" });
  });

  it("rejects with UnsupportedError when the stream is empty", async () => {
    const { remote, sendText, edit } = makeRemote();
    await expect(
      sendStreamText(remote, "chat", await content([]))
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(sendText).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("propagates a mid-stream error after the first send", async () => {
    async function* throwing(): AsyncIterable<string> {
      yield "a";
      throw new Error("boom");
    }
    const { remote, sendText, edit } = makeRemote();
    const built = (await streamText(throwing()).build()) as StreamText;

    await expect(sendStreamText(remote, "chat", built)).rejects.toThrow(BOOM);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });

  it("never exceeds maxEdits total edits", async () => {
    const { remote, edit } = makeRemote();
    await sendStreamText(
      remote,
      "chat",
      await content(["a", "b", "c", "d", "e"], { throttleMs: 0, maxEdits: 3 })
    );

    expect(edit.mock.calls.length).toBeLessThanOrEqual(3);
    // Final edit always carries the complete text regardless of the cap.
    expect(editArgs(edit).at(-1)).toBe("abcde");
  });

  it("stays within the default edit budget and still lands the complete text", async () => {
    const { remote, edit } = makeRemote();
    const words = Array.from({ length: 20 }, (_, index) => `w${index} `);
    await sendStreamText(
      remote,
      "chat",
      // No maxEdits → the default cap applies; throttleMs 0 would otherwise
      // try to edit on every delta and blow past iMessage's ~5-edit limit.
      await content(words, { throttleMs: 0 })
    );

    expect(edit.mock.calls.length).toBeLessThanOrEqual(5);
    expect(editArgs(edit).at(-1)).toBe(words.join(""));
  });
});

describe("iMessage streamText local-mode rejection", () => {
  it("throws UnsupportedError in local mode", async () => {
    const localClient = Object.create(IMessageSDK.prototype) as IMessageSDK;
    const send = imessage.config().__definition.send;

    await expect(
      send({
        space: { id: "chat", phone: "p", type: "dm", __platform: "iMessage" },
        content: await content(["hi"]),
        client: localClient,
      })
    ).rejects.toThrow(LOCAL_MODE);
  });
});
