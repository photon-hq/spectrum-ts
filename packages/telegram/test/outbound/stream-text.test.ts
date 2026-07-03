import { markdown, text, UnsupportedError } from "@spectrum-ts/core";
import { setSystemTime } from "@spectrum-ts/test-support/time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "@/config";
import { send } from "@/outbound/send";

const TS_SEC = 1_700_000_000;
const BOOM = /boom/;
const config = configSchema.parse({ botToken: "1:abc" });
const space = { id: "100" };

interface Captured {
  json: Record<string, unknown>;
  method: string;
}

// `sendMessageDraft` goes through photon's typed function, which validates the
// response against a Zod schema — its mock must echo `{ ok, result: true }`;
// the final `sendMessage` accepts any result.
const responseFor = (method: string): unknown =>
  method === "sendMessageDraft"
    ? { ok: true, result: true }
    : { ok: true, result: { message_id: 555, date: TS_SEC } };

let calls: Captured[];
let failDrafts: boolean;

beforeEach(() => {
  calls = [];
  failDrafts = false;
  const impl = (input: Request): Promise<Response> => {
    const url = input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    const record = async (): Promise<Captured> => ({
      json: (await input.clone().json()) as Record<string, unknown>,
      method,
    });
    return record().then((captured) => {
      calls.push(captured);
      if (failDrafts && method === "sendMessageDraft") {
        return Response.json(
          { description: "draft rejected", ok: false },
          { status: 400 }
        );
      }
      return Response.json(responseFor(method));
    });
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  setSystemTime(); // restore the real clock after time-controlled tests
});

async function* fromArray(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

// A non-zero instant so a frozen Date.now() is unmistakably mocked.
const BASE_MS = 1_000_000;

// Advances the mocked system clock by `stepMs` before each delta, so the
// driver's Date.now()-based throttle is fully deterministic. The clock is
// frozen eagerly (not on first pull): the driver stamps its throttle state
// when it sends the "Thinking…" placeholder, before consuming the stream.
function timed(items: string[], stepMs: number): AsyncIterable<string> {
  setSystemTime(new Date(BASE_MS));
  return (async function* timedGenerator() {
    let now = BASE_MS;
    for (const item of items) {
      now += stepMs;
      setSystemTime(new Date(now));
      yield item;
    }
  })();
}

const drafts = (): Captured[] =>
  calls.filter((c) => c.method === "sendMessageDraft");
const finalSends = (): Captured[] =>
  calls.filter((c) => c.method === "sendMessage");

describe("telegram sendStreamText", () => {
  it("streams drafts and persists the full text with sendMessage", async () => {
    const result = await send({
      space,
      content: await text(timed(["Hello", " world", "!"], 1000)).build(),
      config,
    });

    // "Thinking…" placeholder, then one animated update per (spaced) delta.
    expect(drafts().map((c) => c.json.text)).toEqual([
      "",
      "Hello",
      "Hello world",
      "Hello world!",
    ]);
    // All updates target the same non-zero draft in the numeric chat id.
    const draftIds = new Set(drafts().map((c) => c.json.draft_id));
    expect(draftIds.size).toBe(1);
    expect(draftIds.has(0)).toBe(false);
    for (const draft of drafts()) {
      expect(draft.json.chat_id).toBe(100);
    }

    // The draft is ephemeral — the message must be persisted for real.
    expect(finalSends().map((c) => c.json)).toEqual([
      { chat_id: "100", text: "Hello world!" },
    ]);
    expect(calls.at(-1)?.method).toBe("sendMessage");

    expect(result?.id).toBe("555");
    expect(result?.content).toEqual({ type: "text", text: "Hello world!" });
    expect(result?.space.id).toBe("100");
    expect(result?.timestamp).toEqual(new Date(TS_SEC * 1000));
  });

  it("throttles draft updates when deltas arrive faster than the gap", async () => {
    setSystemTime(new Date(BASE_MS)); // freeze: no time passes, no interim drafts
    await send({
      space,
      content: await text(fromArray(["a", "b", "c"])).build(),
      config,
    });

    // Only the placeholder goes out; the text still lands via sendMessage.
    expect(drafts().map((c) => c.json.text)).toEqual([""]);
    expect(finalSends().map((c) => c.json.text)).toEqual(["abc"]);
  });

  it("rejects group chats before consuming the stream", async () => {
    let pulled = false;
    async function* tracking(): AsyncIterable<string> {
      pulled = true;
      yield "x";
    }

    await expect(
      send({
        space: { id: "-100123" },
        content: await text(tracking()).build(),
        config,
      })
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(pulled).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rejects with UnsupportedError when the stream produces no text", async () => {
    await expect(
      send({
        space,
        content: await text(fromArray([])).build(),
        config,
      })
    ).rejects.toBeInstanceOf(UnsupportedError);

    // The placeholder went out (it expires on its own); nothing was persisted.
    expect(drafts().map((c) => c.json.text)).toEqual([""]);
    expect(finalSends()).toEqual([]);
  });

  it("disables drafts after a failure but still persists the message", async () => {
    failDrafts = true;
    const result = await send({
      space,
      content: await text(timed(["a", "b", "c"], 1000)).build(),
      config,
    });

    // The placeholder attempt fails and no further drafts are tried.
    expect(drafts()).toHaveLength(1);
    expect(finalSends().map((c) => c.json.text)).toEqual(["abc"]);
    expect(result?.id).toBe("555");
  });

  it("renders markdown drafts and the final send as HTML with parse_mode", async () => {
    const result = await send({
      space,
      content: await markdown(timed(["**Hello", " world**"], 1000)).build(),
      config,
    });

    // Each draft re-renders the accumulated markdown; an unclosed marker
    // mid-stream stays literal text, so every preview is valid HTML.
    expect(drafts().map((c) => [c.json.text, c.json.parse_mode])).toEqual([
      ["", "HTML"],
      ["**Hello", "HTML"],
      ["<b>Hello world</b>", "HTML"],
    ]);
    expect(finalSends().map((c) => c.json)).toEqual([
      { chat_id: "100", text: "<b>Hello world</b>", parse_mode: "HTML" },
    ]);
    // The record carries the markdown source, not the rendered HTML.
    expect(result?.content).toEqual({
      type: "markdown",
      markdown: "**Hello world**",
    });
  });

  it("keeps plain streams free of parse_mode", async () => {
    await send({
      space,
      content: await text(timed(["hi"], 1000)).build(),
      config,
    });

    for (const call of calls) {
      expect(call.json.parse_mode).toBeUndefined();
    }
  });

  it("propagates a mid-stream error without sending the message", async () => {
    setSystemTime(new Date(BASE_MS));
    async function* throwing(): AsyncIterable<string> {
      yield "a";
      throw new Error("boom");
    }

    await expect(
      send({ space, content: await text(throwing()).build(), config })
    ).rejects.toThrow(BOOM);
    expect(finalSends()).toEqual([]);
  });
});
