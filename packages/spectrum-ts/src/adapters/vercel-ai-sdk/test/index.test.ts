import { describe, expect, test } from "bun:test";
import { createSpectrumChatHandler } from "../index";

function chatRequest(options: {
  body?: unknown;
  chatId?: string;
  signal?: AbortSignal;
  text?: string;
}): Request {
  return new Request("https://example.com/api/chat", {
    body: JSON.stringify(
      options.body ?? {
        id: options.chatId ?? "chat-1",
        messages: [
          {
            id: "old-message",
            role: "user",
            parts: [{ type: "text", text: "old text" }],
          },
          {
            id: "assistant-message",
            role: "assistant",
            parts: [{ type: "text", text: "old reply" }],
          },
          {
            id: "latest-message",
            role: "user",
            parts: [{ type: "text", text: options.text ?? "hello" }],
          },
        ],
        metadata: { source: "test" },
      }
    ),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: options.signal,
  });
}

describe("createSpectrumChatHandler", () => {
  test("streams a string response for the latest user text", async () => {
    const request = chatRequest({ chatId: "chat-42", text: "hello world" });
    let observed:
      | {
          conversationId: string;
          messagesLength: number;
          metadata: unknown;
          request: Request;
          requestId: string;
          signal: AbortSignal;
          spaceId: string;
          text: string;
          userId: string;
        }
      | undefined;
    const POST = createSpectrumChatHandler({
      respond(context) {
        observed = {
          conversationId: context.conversationId,
          messagesLength: context.messages.length,
          metadata: context.metadata,
          request: context.request,
          requestId: context.requestId,
          signal: context.signal,
          spaceId: context.spaceId,
          text: context.text,
          userId: context.user.id,
        };
        return `Echo: ${context.text}`;
      },
    });

    const response = await POST(request);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("text-start");
    expect(body).toContain("text-delta");
    expect(body).toContain("text-end");
    expect(body).toContain("Echo: hello world");
    expect(body).not.toContain("old text");
    expect(observed).toEqual({
      conversationId: "chat-42",
      messagesLength: 3,
      metadata: { source: "test" },
      request,
      requestId: "latest-message",
      signal: request.signal,
      spaceId: "web:web-user:chat-42",
      text: "hello world",
      userId: "web-user",
    });
  });

  test("passes a user-scoped web space id into respond", async () => {
    let observedSpaceId: string | undefined;
    const POST = createSpectrumChatHandler({
      getUser: () => ({ id: "user:1" }),
      respond: ({ spaceId }) => {
        observedSpaceId = spaceId;
        return spaceId;
      },
    });

    const response = await POST(chatRequest({ chatId: "chat:1" }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(observedSpaceId).toBe("web:user%3A1:chat%3A1");
    expect(body).toContain("web:user%3A1:chat%3A1");
  });

  test("streams an AsyncIterable response", async () => {
    const POST = createSpectrumChatHandler({
      respond: () =>
        (async function* stream() {
          yield "You ";
          yield "said: ";
          yield "hello";
        })(),
    });

    const response = await POST(chatRequest({ text: "hello" }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("You ");
    expect(body).toContain("said: ");
    expect(body).toContain("hello");
  });

  test("returns 400 for invalid JSON", async () => {
    const POST = createSpectrumChatHandler({
      respond: () => "unreachable",
    });
    const request = new Request("https://example.com/api/chat", {
      body: "{",
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be valid JSON.",
    });
  });

  test("returns 400 for missing messages", async () => {
    const POST = createSpectrumChatHandler({
      respond: () => "unreachable",
    });

    const response = await POST(chatRequest({ body: { id: "chat-1" } }));

    expect(response.status).toBe(400);
  });

  test("returns 400 for no user message", async () => {
    const POST = createSpectrumChatHandler({
      respond: () => "unreachable",
    });

    const response = await POST(
      chatRequest({
        body: {
          id: "chat-1",
          messages: [{ id: "a1", role: "assistant", parts: [] }],
        },
      })
    );

    expect(response.status).toBe(400);
  });

  test("returns 400 for no text content", async () => {
    const POST = createSpectrumChatHandler({
      respond: () => "unreachable",
    });

    const response = await POST(
      chatRequest({
        body: {
          id: "chat-1",
          messages: [{ id: "u1", role: "user", parts: [] }],
        },
      })
    );

    expect(response.status).toBe(400);
  });

  test("returns 401 when getUser returns null", async () => {
    const POST = createSpectrumChatHandler({
      getUser: () => null,
      respond: () => "unreachable",
    });

    const response = await POST(chatRequest({ text: "hello" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized." });
  });

  test("passes authenticated user into respond", async () => {
    let userId: string | undefined;
    const POST = createSpectrumChatHandler({
      getUser: () => ({ id: "user-1", role: "tester" }),
      respond: ({ user }) => {
        userId = user.id;
        return `user:${user.id}`;
      },
    });

    const response = await POST(chatRequest({ text: "hello" }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(userId).toBe("user-1");
    expect(body).toContain("user:user-1");
  });

  test("rejects malformed getUser results before respond runs", async () => {
    const POST = createSpectrumChatHandler({
      getUser: () =>
        ({ id: "" }) as unknown as {
          id: string;
        },
      respond: () => {
        throw new Error("respond should not run");
      },
    });

    const response = await POST(chatRequest({ text: "hello" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "getUser(request) must return a user object with a non-empty string id.",
    });
  });

  test("surfaces respond errors as AI SDK UI stream errors", async () => {
    const POST = createSpectrumChatHandler({
      respond: () => {
        throw new Error("responder failed");
      },
    });

    const response = await POST(chatRequest({ text: "hello" }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("error");
    expect(body).toContain("responder failed");
  });

  test("stops streaming when the request is aborted", async () => {
    const controller = new AbortController();
    const POST = createSpectrumChatHandler({
      respond: ({ signal }) =>
        (async function* stream() {
          yield "first";
          controller.abort();
          expect(signal.aborted).toBe(true);
          yield "second";
        })(),
    });

    const response = await POST(
      chatRequest({ signal: controller.signal, text: "hello" })
    );
    const body = await response.text();

    expect(body).toContain("first");
    expect(body).not.toContain("second");
  });
});
