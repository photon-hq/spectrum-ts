import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { asText } from "../../../content/text";
import type { AnyPlatformDef, PlatformRuntime } from "../../../platform/types";
import { Spectrum } from "../../../spectrum";
import type { Space } from "../../../types/space";
import { webBridge } from "../index";

const TEST_TIMEOUT_MS = 500;
const PLATFORM_NAME = "web-bridge";

interface Harness {
  app: Awaited<ReturnType<typeof Spectrum>>;
  cleanup: () => Promise<void>;
  runtime: PlatformRuntime;
  url: string;
}

function bridgeBody(options: {
  messageId?: string;
  requestId?: string;
  responseSessionId?: string;
  spaceId?: string;
  text?: string;
  userId?: string;
}): string {
  return JSON.stringify({
    messageId: options.messageId ?? "message-1",
    metadata: { source: "test" },
    requestId: options.requestId ?? "request-1",
    responseSessionId: options.responseSessionId ?? "session-1",
    spaceId: options.spaceId ?? "web:user-1:chat-1",
    text: options.text ?? "hello",
    userId: options.userId ?? "user-1",
  });
}

async function createHarness(options?: { apiKey?: string }): Promise<Harness> {
  const port = await availablePort();
  const app = await Spectrum({
    providers: [
      webBridge.config({
        responseTimeoutMs: TEST_TIMEOUT_MS,
        server: {
          apiKey: options?.apiKey,
          port,
        },
      }),
    ],
  });
  const runtime = app.__internal.platforms.get(PLATFORM_NAME);
  if (!runtime) {
    throw new Error("Expected webBridge runtime");
  }
  const url = (runtime.client as { url: string }).url;

  return {
    app,
    runtime,
    url,
    cleanup: async () => {
      (runtime.client as { inbound: { close: () => void } }).inbound.close();
      await app.stop();
    },
  };
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

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for webBridge test result"));
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

async function postBridge(
  url: string,
  options?: {
    apiKey?: string;
    body?: string;
  }
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options?.apiKey) {
    headers.set("authorization", `Bearer ${options.apiKey}`);
  }
  return await fetch(url, {
    body: options?.body ?? bridgeBody({}),
    headers,
    method: "POST",
  });
}

function parseEvents(body: string): unknown[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function responseSessionId(space: Space): string {
  const value = (space as { responseSessionId?: unknown }).responseSessionId;
  if (typeof value !== "string") {
    throw new Error("Expected responseSessionId on webBridge space");
  }
  return value;
}

describe("webBridge", () => {
  test("turns HTTP bridge requests into inbound Spectrum messages", async () => {
    const harness = await createHarness();
    const messages = harness.app.messages[Symbol.asyncIterator]();

    try {
      const responsePromise = postBridge(harness.url, {
        body: bridgeBody({ text: "hello world" }),
      });
      const next = await withTimeout(messages.next());

      expect(next.done).toBe(false);
      if (next.done) {
        throw new Error("Expected inbound message");
      }

      const [space, message] = next.value;
      expect(space.id).toBe("web:user-1:chat-1");
      expect(responseSessionId(space)).toBe("session-1");
      expect(message.sender.id).toBe("user-1");
      expect(message.content).toEqual({ type: "text", text: "hello world" });

      await space.send("echo: hello world");

      const response = await responsePromise;
      const events = parseEvents(await withTimeout(response.text()));
      expect(events).toEqual([
        { type: "text_start", requestId: "request-1" },
        {
          type: "text_delta",
          requestId: "request-1",
          delta: "echo: hello world",
        },
        { type: "text_end", requestId: "request-1" },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("matches concurrent same-space responses by responseSessionId", async () => {
    const harness = await createHarness();
    const messages = harness.app.messages[Symbol.asyncIterator]();

    try {
      const slowResponse = postBridge(harness.url, {
        body: bridgeBody({
          requestId: "request-a",
          responseSessionId: "session-a",
          spaceId: "web:user-1:same-chat",
          text: "slow",
        }),
      });
      const fastResponse = postBridge(harness.url, {
        body: bridgeBody({
          messageId: "message-2",
          requestId: "request-b",
          responseSessionId: "session-b",
          spaceId: "web:user-1:same-chat",
          text: "fast",
        }),
      });
      const first = await withTimeout(messages.next());
      const second = await withTimeout(messages.next());

      expect(first.done).toBe(false);
      expect(second.done).toBe(false);
      if (first.done || second.done) {
        throw new Error("Expected both inbound messages");
      }

      const spacesBySession = new Map<string, Space>();
      spacesBySession.set(responseSessionId(first.value[0]), first.value[0]);
      spacesBySession.set(responseSessionId(second.value[0]), second.value[0]);

      await spacesBySession.get("session-b")?.send("fast reply");
      await spacesBySession.get("session-a")?.send("slow reply");

      const fastEvents = parseEvents(
        await withTimeout((await fastResponse).text())
      );
      const slowEvents = parseEvents(
        await withTimeout((await slowResponse).text())
      );

      expect(fastEvents).toContainEqual({
        type: "text_delta",
        requestId: "request-b",
        delta: "fast reply",
      });
      expect(slowEvents).toContainEqual({
        type: "text_delta",
        requestId: "request-a",
        delta: "slow reply",
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("fails text sends when the response session is missing", async () => {
    const harness = await createHarness();

    try {
      await expect(
        (harness.runtime.definition as AnyPlatformDef).send({
          client: harness.runtime.client,
          config: harness.runtime.config,
          content: asText("orphaned reply"),
          space: {
            id: "web:user-1:missing-session",
            __platform: PLATFORM_NAME,
            responseSessionId: "missing-session",
          },
          store: harness.runtime.store,
        })
      ).rejects.toThrow("no active response session");
    } finally {
      await harness.cleanup();
    }
  });

  test("requires bearer auth when an api key is configured", async () => {
    const harness = await createHarness({ apiKey: "secret" });

    try {
      const response = await postBridge(harness.url);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized." });
    } finally {
      await harness.cleanup();
    }
  });

  test("closes timed-out sessions with an error event", async () => {
    const harness = await createHarness();
    const messages = harness.app.messages[Symbol.asyncIterator]();

    try {
      const response = await postBridge(harness.url);
      const next = await withTimeout(messages.next());
      expect(next.done).toBe(false);

      const events = parseEvents(await withTimeout(response.text()));
      expect(events).toEqual([
        { type: "error", requestId: "request-1", message: "timeout" },
      ]);
      expect(
        (
          harness.runtime.client as {
            pendingByResponseSessionId: Map<string, unknown>;
          }
        ).pendingByResponseSessionId.size
      ).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});
