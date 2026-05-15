import { describe, expect, test } from "bun:test";
import { asText } from "../../../content/text";
import type { AnyPlatformDef, PlatformRuntime } from "../../../platform/types";
import { Spectrum } from "../../../spectrum";
import type { Store } from "../../../utils/store";
import { vercelAiSdkUI } from "../index";

// These tests exercise the provider directly rather than spinning up a
// framework app. That keeps Phase 1 focused on the Spectrum/useChat bridge.
const TEST_TIMEOUT_MS = 1000;
const PLATFORM_NAME = "vercel-ai-sdk-ui";

interface Harness {
  app: Awaited<ReturnType<typeof Spectrum>>;
  cleanup: () => Promise<void>;
  messages: AsyncIterator<{
    content: unknown;
    id: string;
    sender: { id: string };
    space: { id: string };
  }>;
  runtime: PlatformRuntime;
}

function chatRequest(options: {
  chatId?: string;
  signal?: AbortSignal;
  text?: string;
  userId?: string;
}): Request {
  return new Request("https://example.com/api/chat", {
    body: JSON.stringify({
      id: options.chatId ?? "chat-1",
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: options.text ?? "hello" }],
        },
      ],
      metadata: { userId: options.userId ?? "user-1" },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: options.signal,
  });
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for Vercel AI SDK UI test result"));
    }, TEST_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createHarness(): Promise<Harness> {
  const app = await Spectrum({
    providers: [
      vercelAiSdkUI.config({
        responseTimeoutMs: TEST_TIMEOUT_MS,
      }),
    ],
  });
  const runtime = app.__internal.platforms.get(PLATFORM_NAME);
  if (!runtime) {
    throw new Error("Expected Vercel AI SDK UI runtime");
  }
  const messages = (runtime.definition as AnyPlatformDef)
    .messages({
      client: runtime.client,
      config: runtime.config,
      store: runtime.store,
    })
    [Symbol.asyncIterator]() as Harness["messages"];

  return {
    app,
    cleanup: async () => {
      await messages.return?.();
      await app.stop();
    },
    messages,
    runtime,
  };
}

async function sendProviderText(
  runtime: PlatformRuntime,
  spaceId: string,
  value: string
): Promise<unknown> {
  return await (runtime.definition as AnyPlatformDef).send({
    client: runtime.client,
    config: runtime.config,
    content: asText(value),
    space: { id: spaceId, __platform: PLATFORM_NAME },
    store: runtime.store as Store,
  });
}

describe("vercelAiSdkUI", () => {
  test("bridges a useChat request into Spectrum and streams the outbound text response", async () => {
    const harness = await createHarness();

    try {
      const response = await vercelAiSdkUI.handle(
        harness.app,
        chatRequest({ chatId: "chat-1", text: "hello world" })
      );
      const next = await withTimeout(harness.messages.next());
      expect(next.done).toBe(false);
      if (next.done) {
        throw new Error("Expected inbound message");
      }
      const message = next.value;

      expect(message.space.id).toBe("chat-1");
      expect(message.sender.id).toBe("user-1");
      expect(message.content).toEqual({ type: "text", text: "hello world" });

      await sendProviderText(
        harness.runtime,
        message.space.id,
        "echo: hello world"
      );

      const body = await withTimeout(response.text());
      expect(body).toContain("text-start");
      expect(body).toContain("text-delta");
      expect(body).toContain("text-end");
      expect(body).toContain("echo: hello world");
    } finally {
      await harness.cleanup();
    }
  });

  test("fails text sends when no response session is active", async () => {
    const harness = await createHarness();

    try {
      await expect(
        sendProviderText(harness.runtime, "missing-session", "orphaned reply")
      ).rejects.toThrow("no active AI SDK UI response session");
    } finally {
      await harness.cleanup();
    }
  });

  test("handles already-aborted requests without registering a pending session", async () => {
    const app = await Spectrum({
      providers: [vercelAiSdkUI.config()],
    });
    const controller = new AbortController();
    controller.abort();

    try {
      const response = await vercelAiSdkUI.handle(
        app,
        chatRequest({ signal: controller.signal })
      );
      const runtime = app.__internal.platforms.get("vercel-ai-sdk-ui");
      const client = runtime?.client as
        | { pendingBySpaceId: Map<string, unknown[]> }
        | undefined;

      expect(response.status).toBe(499);
      expect(client?.pendingBySpaceId.size).toBe(0);
    } finally {
      await app.stop();
    }
  });

  test("matches concurrent same-space responses by FIFO order", async () => {
    const harness = await createHarness();

    try {
      const firstResponse = await vercelAiSdkUI.handle(
        harness.app,
        chatRequest({ chatId: "same-chat", text: "first" })
      );
      const secondResponse = await vercelAiSdkUI.handle(
        harness.app,
        chatRequest({ chatId: "same-chat", text: "second" })
      );
      const firstBody = firstResponse.text();
      const secondBody = secondResponse.text();
      const firstInbound = await withTimeout(harness.messages.next());
      const secondInbound = await withTimeout(harness.messages.next());

      expect(firstInbound.done).toBe(false);
      expect(secondInbound.done).toBe(false);
      if (firstInbound.done || secondInbound.done) {
        throw new Error("Expected both inbound messages");
      }

      const firstMessage = firstInbound.value;
      const secondMessage = secondInbound.value;
      expect(firstMessage.content).toEqual({ type: "text", text: "first" });
      expect(secondMessage.content).toEqual({ type: "text", text: "second" });

      await sendProviderText(
        harness.runtime,
        secondMessage.space.id,
        "reply sent from second inbound"
      );
      await sendProviderText(
        harness.runtime,
        secondMessage.space.id,
        "reply sent after FIFO advances"
      );

      expect(await withTimeout(firstBody)).toContain(
        "reply sent from second inbound"
      );
      expect(await withTimeout(secondBody)).toContain(
        "reply sent after FIFO advances"
      );
    } finally {
      await harness.cleanup();
    }
  });
});
