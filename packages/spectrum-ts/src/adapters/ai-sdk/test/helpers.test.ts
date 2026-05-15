import { describe, expect, test } from "bun:test";
import { aiSdkMessagesFromSpace, streamTextToSpace } from "../index";

describe("AI SDK adoption helpers", () => {
  test("aiSdkMessagesFromSpace includes the latest Spectrum text message", async () => {
    const messages = await aiSdkMessagesFromSpace(
      {},
      {
        includeLatest: {
          content: { text: "hello", type: "text" },
          id: "message-1",
          role: "user",
        },
      }
    );

    expect(messages).toEqual([
      {
        id: "message-1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("streamTextToSpace sends text output through Spectrum space", async () => {
    const sent: unknown[] = [];

    await streamTextToSpace(
      {
        send: async (content: unknown) => {
          sent.push(content);
        },
      },
      {
        stream: new ReadableStream<string>({
          start(controller) {
            controller.enqueue("hello");
            controller.enqueue(" world");
            controller.close();
          },
        }),
      }
    );

    expect(sent).toEqual(["hello world"]);
  });
});
