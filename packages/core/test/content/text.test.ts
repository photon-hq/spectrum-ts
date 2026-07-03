import { describe, expect, it } from "vitest";
import type { StreamText, StreamTextSource } from "@/content/stream-text";
import { text } from "@/content/text";
import type { ContentBuilder } from "@/content/types";

const UNRECOGNIZED_SHAPE = /unrecognized chunk shape/;
const ALREADY_CONSUMED = /already been consumed/;
const CONTENT_BUILDER = /not another content builder/;

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

const readableOf = <T>(items: T[]): ReadableStream<T> =>
  new ReadableStream<T>({
    start(controller) {
      for (const item of items) {
        controller.enqueue(item);
      }
      controller.close();
    },
  });

const drain = async (stream: AsyncIterable<string>): Promise<string[]> => {
  const seen: string[] = [];
  for await (const delta of stream) {
    seen.push(delta);
  }
  return seen;
};

const collect = async (source: StreamTextSource): Promise<string[]> => {
  const content = (await text(source).build()) as StreamText;
  return drain(content.stream());
};

describe("text strings", () => {
  it("builds a text content value", async () => {
    expect(await text("hi").build()).toEqual({ type: "text", text: "hi" });
  });

  it("rejects an empty string at build time", async () => {
    await expect(text("").build()).rejects.toThrow();
  });

  it("ignores stream options on a string source", async () => {
    const callText = text as unknown as (
      source: string,
      options?: unknown
    ) => ContentBuilder;
    expect(await callText("hi", { extract: () => "nope" }).build()).toEqual({
      type: "text",
      text: "hi",
    });
  });
});

describe("text streams", () => {
  it("builds streamText content with no format", async () => {
    const content = (await text(fromArray(["x"])).build()) as StreamText;
    expect(content.type).toBe("streamText");
    expect(content.format).toBeUndefined();
  });

  it("rejects a content builder passed as a stream source", () => {
    expect(() => text(text("hi") as unknown as AsyncIterable<string>)).toThrow(
      CONTENT_BUILDER
    );
  });

  it("passes through a raw string async iterable", async () => {
    expect(await collect(fromArray(["Hel", "lo"]))).toEqual(["Hel", "lo"]);
  });

  it("reads a ReadableStream of strings", async () => {
    expect(await collect(readableOf(["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });

  it("picks up the AI SDK result's .textStream (async iterable)", async () => {
    expect(await collect({ textStream: fromArray(["x", "y"]) })).toEqual([
      "x",
      "y",
    ]);
  });

  it("picks up the AI SDK result's .textStream (ReadableStream)", async () => {
    expect(await collect({ textStream: readableOf(["x", "y"]) })).toEqual([
      "x",
      "y",
    ]);
  });

  it("extracts OpenAI chat.completions deltas and skips role/finish chunks", async () => {
    const chunks = [
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    expect(await collect(fromArray(chunks))).toEqual(["Hel", "lo"]);
  });

  it("extracts OpenAI responses deltas and skips lifecycle events", async () => {
    const events = [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.output_text.done" },
      { type: "response.completed" },
    ];
    expect(await collect(fromArray(events))).toEqual(["Hel", "lo"]);
  });

  it("extracts Anthropic content_block_delta and skips control events", async () => {
    const events = [
      { type: "message_start" },
      { type: "content_block_start" },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      },
      { type: "ping" },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "lo" },
      },
      { type: "content_block_stop" },
      { type: "message_delta" },
      { type: "message_stop" },
    ];
    expect(await collect(fromArray(events))).toEqual(["Hel", "lo"]);
  });

  it("uses a custom extract over the built-in detection", async () => {
    const chunks = [{ piece: "Hel" }, { piece: "lo" }, { piece: null }];
    const content = (await text(fromArray(chunks), {
      extract: (chunk) => chunk.piece,
    }).build()) as StreamText;
    expect(await drain(content.stream())).toEqual(["Hel", "lo"]);
  });

  it("filters out empty-string deltas", async () => {
    expect(await collect(fromArray(["a", "", "b"]))).toEqual(["a", "b"]);
  });

  it("throws a helpful error on an unrecognized chunk shape", async () => {
    const content = (await text(
      fromArray([{ mystery: 1 }])
    ).build()) as StreamText;
    await expect(drain(content.stream())).rejects.toThrow(UNRECOGNIZED_SHAPE);
  });

  it("throws when the source is consumed twice", async () => {
    const content = (await text(fromArray(["a", "b"])).build()) as StreamText;
    await drain(content.stream());
    await expect(drain(content.stream())).rejects.toThrow(ALREADY_CONSUMED);
  });
});
