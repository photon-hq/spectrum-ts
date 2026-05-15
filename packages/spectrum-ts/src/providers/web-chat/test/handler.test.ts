import { describe, expect, test } from "bun:test";
import { createWebChatHandler } from "../handler";

const validBody = {
  conversationId: "conversation-1",
  id: "chat-1",
  idempotencyKey: "message-1",
  messages: [
    {
      id: "message-1",
      parts: [{ text: "hello", type: "text" }],
      role: "user",
    },
  ],
  requestId: "request-1",
  submittedMessageId: "message-1",
  trigger: "submit-message",
};

function request(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://127.0.0.1:8787/ai-sdk/chat", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

describe("createWebChatHandler", () => {
  test("validates one submitted browser turn", async () => {
    const received: unknown[] = [];
    const handler = createWebChatHandler({
      enqueue: async (message) => {
        received.push(message);
      },
      resolveUser: async () => ({ id: "user-1" }),
    });

    const response = await handler(request(validBody));

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      content: { text: "hello", type: "text" },
      id: "message-1",
      sender: { id: "user-1" },
      space: {
        conversationId: "conversation-1",
        id: "web:user-1:conversation-1",
        requestId: "request-1",
      },
    });
  });

  test("rejects missing submittedMessageId safely", async () => {
    const handler = createWebChatHandler({
      enqueue: async () => undefined,
      resolveUser: async () => ({ id: "user-1" }),
    });

    const response = await handler(
      request({ ...validBody, submittedMessageId: undefined })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        requestId: "request-1",
        retryable: false,
        type: "invalid_submitted_message",
      },
    });
  });

  test("scopes duplicate conversation ids by trusted user", async () => {
    const received: unknown[] = [];
    const handler = createWebChatHandler({
      enqueue: async (message) => {
        received.push(message);
      },
      resolveUser: async (requestArg) => ({
        id: requestArg.headers.get("x-user-id") ?? "anonymous",
      }),
    });

    await handler(request(validBody, { "x-user-id": "user-a" }));
    await handler(request(validBody, { "x-user-id": "user-b" }));

    expect(received).toHaveLength(2);
    expect(
      received.map((message) => (message as { space: { id: string } }).space.id)
    ).toEqual(["web:user-a:conversation-1", "web:user-b:conversation-1"]);
  });
});
