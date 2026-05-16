import { describe, expect, test } from "bun:test";
import z from "zod";
import { asText } from "../../../content/text";
import { definePlatform } from "../../../platform/define";
import type {
  ProviderMessage,
  ProviderMessageRecord,
} from "../../../platform/types";
import { Spectrum } from "../../../spectrum";
import { webChat } from "../index";
import { type AsyncQueue, makeAsyncQueue } from "../queue";

const TEST_TIMEOUT_MS = 500;

interface FakeClient {
  inbound: AsyncQueue<FakeMessage>;
  sent: ProviderMessageRecord[];
}

type FakeMessage = ProviderMessage<{ id: string }, { id: string }>;

const fakeSpaceSchema = z.object({ id: z.string().min(1) });

const fakeProvider = definePlatform("fakeProvider", {
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
  user: { resolve: async ({ input }) => ({ id: input.userID }) },
  space: {
    params: fakeSpaceSchema,
    schema: fakeSpaceSchema,
    resolve: async ({ input }) => fakeSpaceSchema.parse(input.params),
  },
  async *messages({ client }) {
    for await (const message of client.inbound.iter) {
      yield message;
    }
  },
  send: async ({ client, content, space }) => {
    const sent = {
      content,
      id: "fake-outbound",
      space,
      timestamp: new Date(),
    };
    client.sent.push(sent);
    return sent;
  },
});

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for integration result"));
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

function requestBody(): string {
  return JSON.stringify({
    id: "chat-1",
    idempotencyKey: "message-1",
    messages: [
      {
        id: "message-1",
        parts: [{ text: "from web", type: "text" }],
        role: "user",
      },
    ],
    requestId: "request-1",
    submittedMessageId: "message-1",
    trigger: "submit-message",
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

describe("webChat runtime integration", () => {
  test("coexists with another provider in one app.messages loop", async () => {
    const app = await Spectrum({
      providers: [
        fakeProvider.config(),
        webChat.config({
          responseTimeoutMs: TEST_TIMEOUT_MS,
          server: { port: 0 },
        }),
      ],
    });
    const fakeRuntime = app.__internal.platforms.get("fakeProvider");
    const webRuntime = app.__internal.platforms.get("webChat");
    if (!(fakeRuntime && webRuntime)) {
      throw new Error("Expected fakeProvider and webChat runtimes");
    }

    const iterator = app.messages[Symbol.asyncIterator]();

    try {
      const responsePromise = fetch(
        (webRuntime.client as { url: string }).url,
        {
          body: requestBody(),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );

      (fakeRuntime.client as FakeClient).inbound.push({
        content: asText("from fake"),
        id: "fake-message-1",
        sender: { id: "user-1" },
        space: { id: "fake:user-1" },
        timestamp: new Date(),
      });

      const first = await withTimeout(iterator.next());
      const second = await withTimeout(iterator.next());
      if (first.done || second.done) {
        throw new Error("Expected two provider messages");
      }

      const entries = [first.value, second.value];
      const webEntry = entries.find(
        ([, message]) =>
          message.content.type === "text" && message.content.text === "from web"
      );
      const fakeEntry = entries.find(
        ([, message]) =>
          message.content.type === "text" &&
          message.content.text === "from fake"
      );

      expect(webEntry).toBeDefined();
      expect(fakeEntry).toBeDefined();

      await webEntry?.[0].send("web reply");
      await fakeEntry?.[0].send("fake reply");

      const response = await responsePromise;
      expect(parseSse(await withTimeout(response.text()))).toContainEqual({
        type: "text-delta",
        id: "request-1-text-1",
        delta: "web reply",
      });
      expect((fakeRuntime.client as FakeClient).sent).toMatchObject([
        { content: { type: "text", text: "fake reply" } },
      ]);
    } finally {
      // The test holds an active app.messages consumer; closing provider
      // queues before app.stop() lets the merged stream drain deterministically.
      (fakeRuntime.client as FakeClient).inbound.close();
      (webRuntime.client as { inbound: { close: () => void } }).inbound.close();
      await app.stop();
    }
  });
});
