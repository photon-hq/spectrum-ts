import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { asText } from "../../../content/text";
import type { AnyPlatformDef, PlatformRuntime } from "../../../platform/types";
import { Spectrum } from "../../../spectrum";
import { webChat } from "../index";

const TEST_TIMEOUT_MS = 500;
const PLATFORM_NAME = "webChat";

interface Harness {
  app: Awaited<ReturnType<typeof Spectrum>>;
  cleanup: () => Promise<void>;
  runtime: PlatformRuntime;
  url: string;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve test port");
  }
  return address.port;
}

async function createHarness(): Promise<Harness> {
  const port = await availablePort();
  const app = await Spectrum({
    providers: [
      webChat.config({
        responseTimeoutMs: TEST_TIMEOUT_MS,
        server: { port },
      }),
    ],
  });
  const runtime = app.__internal.platforms.get(PLATFORM_NAME);
  if (!runtime) {
    throw new Error("Expected webChat runtime");
  }

  return {
    app,
    runtime,
    url: (runtime.client as { url: string }).url,
    cleanup: async () => {
      (runtime.client as { inbound: { close: () => void } }).inbound.close();
      await app.stop();
    },
  };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for webChat test result"));
    }, TEST_TIMEOUT_MS * 4);
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

function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
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
    ...overrides,
  });
}

async function postChat(
  url: string,
  options?: { body?: string }
): Promise<Response> {
  return await fetch(url, {
    body: options?.body ?? requestBody(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function parseSse(body: string): unknown[] {
  return body
    .split("\n\n")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("data: "))
    .map((part) => part.slice("data: ".length))
    .filter((part) => part !== "[DONE]")
    .map((part) => JSON.parse(part) as unknown);
}

describe("webChat provider", () => {
  test("turns AI SDK requests into Spectrum messages and streams replies", async () => {
    const harness = await createHarness();
    const messages = harness.app.messages[Symbol.asyncIterator]();

    try {
      const responsePromise = postChat(harness.url);
      const next = await withTimeout(messages.next());

      expect(next.done).toBe(false);
      if (next.done) {
        throw new Error("Expected webChat message");
      }

      const [space, message] = next.value;
      expect(space.id).toBe("web:anonymous:chat-1");
      expect(message.content).toEqual({ type: "text", text: "hello" });

      await space.send("hello from Spectrum");

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(parseSse(await withTimeout(response.text()))).toContainEqual({
        type: "text-delta",
        id: "request-1-text-1",
        delta: "hello from Spectrum",
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("send fails safely when the request stream is missing", async () => {
    const harness = await createHarness();

    try {
      await expect(
        (harness.runtime.definition as AnyPlatformDef).send({
          client: harness.runtime.client,
          config: harness.runtime.config,
          content: asText("orphaned reply"),
          space: {
            __platform: PLATFORM_NAME,
            id: "web:anonymous:chat-1",
            requestId: "missing-request",
          },
          store: harness.runtime.store,
        })
      ).rejects.toThrow("no active webChat response session");
    } finally {
      await harness.cleanup();
    }
  });

  test("releases the HTTP port when the Spectrum app stops", async () => {
    const port = await availablePort();
    const app = await Spectrum({
      providers: [webChat.config({ server: { port } })],
    });

    await app.stop();

    const second = await Spectrum({
      providers: [webChat.config({ server: { port } })],
    });

    await second.stop();
  });
});
