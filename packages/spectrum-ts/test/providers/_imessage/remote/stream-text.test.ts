import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type {
  AdvancedIMessage,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { type StreamText, streamText } from "@/content/stream-text";
import { imessage } from "@/providers/imessage";
import { sendStreamText } from "@/providers/imessage/remote/stream-text";
import { UnsupportedError } from "@/utils/errors";

const SENT_DATE = new Date(1_700_000_000_000);
const LOCAL_MODE = /local mode/;
const BOOM = /boom/;

// iMessage caps a message at ~5 edits; the driver stays within that budget.
const MAX_EDITS = 5;

afterEach(() => {
  setSystemTime(); // restore the real clock after time-controlled tests
});

const makeRemote = () => {
  const reply = {
    guid: "msg-guid",
    dateCreated: SENT_DATE,
  } as unknown as SDKMessage;
  const editTimes: number[] = [];
  const sendText = mock((_chat: string, _text: string) =>
    Promise.resolve(reply)
  );
  const edit = mock((_chat: string, _guid: string, _text: string) => {
    editTimes.push(Date.now());
    return Promise.resolve(reply);
  });
  const remote = {
    messages: { sendText, edit },
  } as unknown as AdvancedIMessage;
  return { remote, sendText, edit, editTimes };
};

async function* fromArray(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

// Advances the mocked system clock by `stepMs` before each delta, so the
// driver's Date.now()-based backoff is fully deterministic.
function timed(items: string[], stepMs: number): AsyncIterable<string> {
  return (async function* timedGenerator() {
    let now = 0;
    setSystemTime(new Date(now));
    for (const item of items) {
      now += stepMs;
      setSystemTime(new Date(now));
      yield item;
    }
  })();
}

const build = async (source: AsyncIterable<string>): Promise<StreamText> =>
  (await streamText(source).build()) as StreamText;

// `editArgs` → the new-text argument of each edit call, in order.
const editArgs = (edit: ReturnType<typeof makeRemote>["edit"]): string[] =>
  edit.mock.calls.map((call) => call[2]);

describe("sendStreamText", () => {
  it("sends the first delta then flushes the full text on completion", async () => {
    setSystemTime(new Date(0)); // freeze: no time passes, so no interim edits
    const { remote, sendText, edit } = makeRemote();
    const result = await sendStreamText(
      remote,
      "chat",
      await build(fromArray(["Hello", " ", "world"]))
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

  it("sends a single message and no edit for a one-delta stream", async () => {
    setSystemTime(new Date(0));
    const { remote, sendText, edit } = makeRemote();
    const result = await sendStreamText(
      remote,
      "chat",
      await build(fromArray(["hi"]))
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]).toEqual(["chat", "hi"]);
    expect(edit).not.toHaveBeenCalled();
    expect(result.content).toEqual({ type: "text", text: "hi" });
  });

  it("backs off, stays within the edit budget, and lands the complete text", async () => {
    const { remote, sendText, edit, editTimes } = makeRemote();
    // 40 tokens, one per simulated second. With backoff the interim edits land
    // ~2s, 4s, 8s, 16s apart; everything after the budget is exhausted waits
    // for the final flush.
    const words = Array.from({ length: 40 }, (_, index) => `w${index} `);
    await sendStreamText(remote, "chat", await build(timed(words, 1000)));

    expect(sendText).toHaveBeenCalledTimes(1);

    // Stays within iMessage's edit cap.
    expect(edit.mock.calls.length).toBeLessThanOrEqual(MAX_EDITS);

    // Gaps between consecutive edits strictly grow (exponential backoff).
    const gaps = editTimes
      .slice(1)
      .map((time, index) => time - (editTimes[index] as number));
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i] as number).toBeGreaterThan(gaps[i - 1] as number);
    }

    // Each edit carries the cumulative text, and the last one is complete.
    const texts = editArgs(edit);
    for (let i = 1; i < texts.length; i++) {
      expect((texts[i] as string).length).toBeGreaterThan(
        (texts[i - 1] as string).length
      );
    }
    expect(texts.at(-1)).toBe(words.join(""));
  });

  it("rejects with UnsupportedError when the stream is empty", async () => {
    const { remote, sendText, edit } = makeRemote();
    await expect(
      sendStreamText(remote, "chat", await build(fromArray([])))
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(sendText).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("propagates a mid-stream error after the first send", async () => {
    setSystemTime(new Date(0));
    async function* throwing(): AsyncIterable<string> {
      yield "a";
      throw new Error("boom");
    }
    const { remote, sendText, edit } = makeRemote();

    await expect(
      sendStreamText(remote, "chat", await build(throwing()))
    ).rejects.toThrow(BOOM);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });
});

describe("iMessage streamText local-mode rejection", () => {
  it("throws UnsupportedError in local mode", async () => {
    const localClient = Object.create(IMessageSDK.prototype) as IMessageSDK;
    const send = imessage.config().__definition.send;

    await expect(
      send({
        space: { id: "chat", phone: "p", type: "dm", __platform: "iMessage" },
        content: await build(fromArray(["hi"])),
        client: localClient,
      })
    ).rejects.toThrow(LOCAL_MODE);
  });
});
