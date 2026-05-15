import { describe, expect, test } from "bun:test";
import { SpectrumChatTransport } from "../index";

function sseChunk(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function doneChunk(): string {
  return "data: [DONE]\n\n";
}

describe("SpectrumChatTransport", () => {
  test("posts an explicit Spectrum webChat request envelope", async () => {
    let captured:
      | {
          body: unknown;
          headers: Record<string, string>;
          url: string;
        }
      | undefined;

    const fetchMock = (async (input, init) => {
      captured = {
        body: JSON.parse(String(init?.body)) as unknown,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        url: String(input),
      };

      return new Response(
        sseChunk({ type: "text-start", id: "text-1" }) +
          sseChunk({ type: "text-delta", id: "text-1", delta: "hello" }) +
          sseChunk({ type: "text-end", id: "text-1" }) +
          doneChunk(),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
          },
        }
      );
    }) as typeof fetch;

    const transport = new SpectrumChatTransport({
      agentId: "assistant",
      conversationId: "conversation-1",
      endpoint: "https://runtime.example.test/ai-sdk/chat",
      fetch: fetchMock,
      headers: async () => ({
        authorization: "Bearer test-token",
      }),
    });

    const stream = await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messageId: undefined,
      messages: [
        {
          id: "user-message-1",
          metadata: undefined,
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
      trigger: "submit-message",
    });

    const chunks = await Array.fromAsync(stream);

    expect(chunks).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "hello" },
      { type: "text-end", id: "text-1" },
    ]);
    expect(captured?.url).toBe("https://runtime.example.test/ai-sdk/chat");
    expect(captured?.headers.authorization).toBe("Bearer test-token");
    expect(captured?.body).toMatchObject({
      agentId: "assistant",
      conversationId: "conversation-1",
      id: "chat-1",
      idempotencyKey: "user-message-1",
      messages: [
        {
          id: "user-message-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
      submittedMessageId: "user-message-1",
      trigger: "submit-message",
    });
    expect(typeof (captured?.body as { requestId?: unknown }).requestId).toBe(
      "string"
    );
  });

  test("uses AI SDK messageId as the submitted message for regeneration", async () => {
    let body: unknown;
    const fetchMock = (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as unknown;
      return new Response(doneChunk(), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const transport = new SpectrumChatTransport({
      endpoint: "/ai-sdk/chat",
      fetch: fetchMock,
    });

    await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messageId: "assistant-message-1",
      messages: [
        {
          id: "assistant-message-1",
          metadata: undefined,
          parts: [{ text: "old answer", type: "text" }],
          role: "assistant",
        },
      ],
      trigger: "regenerate-message",
    });

    expect(body).toMatchObject({
      idempotencyKey: "assistant-message-1",
      submittedMessageId: "assistant-message-1",
      trigger: "regenerate-message",
    });
  });
});
