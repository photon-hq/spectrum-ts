import { describe, expect, test } from "bun:test";
import z from "zod";
import { asText } from "../../../content/text";
import { definePlatform } from "../../../platform/define";
import type { ProviderMessage } from "../../../platform/types";
import { Spectrum } from "../../../spectrum";
import type { AsyncQueue } from "../../vercel-ai-sdk-ui/queue";
import { makeAsyncQueue } from "../../vercel-ai-sdk-ui/queue";
import { webBridge } from "../index";

const TEST_TIMEOUT_MS = 500;

type FakeMessage = ProviderMessage<{ id: string }, { id: string }>;

interface FakeClient {
  inbound: AsyncQueue<FakeMessage>;
  sent: string[];
}

const fakePersistentProvider = definePlatform("fake-persistent", {
  config: z.object({}),
  lifecycle: {
    createClient: async (): Promise<FakeClient> => ({
      inbound: makeAsyncQueue<FakeMessage>(),
      sent: [],
    }),
    destroyClient: async ({ client }) => {
      client.inbound.close();
    },
  },
  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },
  space: {
    params: z.object({ id: z.string().min(1) }),
    resolve: async ({ input }) => ({ id: input.params?.id ?? "fake-space" }),
  },
  async *messages({ client }) {
    for await (const message of client.inbound.iter) {
      yield message;
    }
  },
  send: async ({ client, content, space }) => {
    if (content.type === "text") {
      client.sent.push(content.text);
    }
    return {
      id: "fake-outbound",
      content,
      space,
      timestamp: new Date(),
    };
  },
});

function bridgeBody(): string {
  return JSON.stringify({
    messageId: "web-message-1",
    requestId: "web-request-1",
    responseSessionId: "web-session-1",
    spaceId: "web:user-1:chat-1",
    text: "hello from web",
    userId: "user-1",
  });
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for webBridge integration test"));
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

function parseEvents(body: string): unknown[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("webBridge integration", () => {
  test("coexists with another persistent provider in one Spectrum instance", async () => {
    const app = await Spectrum({
      providers: [
        fakePersistentProvider.config(),
        webBridge.config({
          responseTimeoutMs: TEST_TIMEOUT_MS,
          server: { port: 8877 },
        }),
      ],
    });
    const fakeRuntime = app.__internal.platforms.get("fake-persistent");
    const webRuntime = app.__internal.platforms.get("web-bridge");
    if (!(fakeRuntime && webRuntime)) {
      throw new Error("Expected both runtimes");
    }
    const fakeClient = fakeRuntime.client as FakeClient;
    const webUrl = (webRuntime.client as { url: string }).url;
    const messages = app.messages[Symbol.asyncIterator]();

    try {
      const webResponse = fetch(webUrl, {
        body: bridgeBody(),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      fakeClient.inbound.push({
        id: "fake-message-1",
        content: asText("hello from fake"),
        sender: { id: "fake-user" },
        space: { id: "fake-space" },
      });

      const received = [
        await withTimeout(messages.next()),
        await withTimeout(messages.next()),
      ];
      const webTuple = received.find(
        (next) => !next.done && next.value[1].platform === "web-bridge"
      );
      const fakeTuple = received.find(
        (next) => !next.done && next.value[1].platform === "fake-persistent"
      );

      expect(webTuple?.done).toBe(false);
      expect(fakeTuple?.done).toBe(false);
      if (!webTuple || webTuple.done || !fakeTuple || fakeTuple.done) {
        throw new Error("Expected both provider messages");
      }

      await webTuple.value[0].send("web reply");
      await fakeTuple.value[0].send("fake reply");

      const events = parseEvents(await withTimeout((await webResponse).text()));
      expect(events).toContainEqual({
        type: "text_delta",
        requestId: "web-request-1",
        delta: "web reply",
      });
      expect(fakeClient.sent).toEqual(["fake reply"]);
    } finally {
      fakeClient.inbound.close();
      (webRuntime.client as { inbound: { close: () => void } }).inbound.close();
      await app.stop();
    }
  });
});
