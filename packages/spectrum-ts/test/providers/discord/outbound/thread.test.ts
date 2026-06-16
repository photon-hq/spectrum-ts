import { beforeEach, describe, expect, it, mock } from "bun:test";

// thread.ts builds a REST client and calls the thread-start helpers. Stub those
// helpers so each call's channel/message ids and body are observable, and so the
// returned thread id flows back through `startThread`/`createThread`. (thread.ts
// imports them via "../client", the same module this aliases.)
interface ThreadBody {
  auto_archive_duration?: number;
  invitable?: boolean;
  name: string;
  rate_limit_per_user?: number;
  type?: number;
}

const startThreadFromMessageMock = mock(
  (
    _client: unknown,
    _channelId: string,
    _messageId: string,
    _body: ThreadBody
  ): Promise<{ id: string }> => Promise.resolve({ id: "thread-from-message" })
);

const startChannelThreadMock = mock(
  (
    _client: unknown,
    _channelId: string,
    _body: ThreadBody
  ): Promise<{ id: string }> => Promise.resolve({ id: "standalone-thread" })
);

mock.module("@/providers/discord/client", () => ({
  discordClient: () => ({}),
  startThreadFromMessage: startThreadFromMessageMock,
  startChannelThread: startChannelThreadMock,
}));

import { configSchema } from "@/providers/discord/config";
import { createThread, startThread } from "@/providers/discord/outbound/thread";
import type { Message } from "@/types/message";

const config = configSchema.parse({
  botToken: "abc.def.ghi",
  applicationId: "999",
});

// A minimal stand-in: `startThread` only reads `id` and `space.id`.
const stubMessage = (id: string, channelId: string): Message =>
  ({ id, space: { id: channelId } }) as unknown as Message;

beforeEach(() => {
  startThreadFromMessageMock.mockReset();
  startThreadFromMessageMock.mockResolvedValue({ id: "thread-from-message" });
  startChannelThreadMock.mockReset();
  startChannelThreadMock.mockResolvedValue({ id: "standalone-thread" });
});

describe("startThread", () => {
  it("starts a thread from a message and returns the thread id", async () => {
    const id = await startThread({
      config,
      message: stubMessage("5", "100"),
      name: "Bug triage",
    });
    expect(id).toBe("thread-from-message");
    expect(startThreadFromMessageMock).toHaveBeenCalledTimes(1);
    const [, channelId, messageId, body] =
      startThreadFromMessageMock.mock.calls.at(0) ?? [];
    expect(channelId).toBe("100");
    expect(messageId).toBe("5");
    expect(body?.name).toBe("Bug triage");
  });

  it("resolves a flattened group-item id to the underlying snowflake", async () => {
    await startThread({
      config,
      message: stubMessage("5:1", "100"),
      name: "thread",
    });
    const [, , messageId] = startThreadFromMessageMock.mock.calls.at(0) ?? [];
    expect(messageId).toBe("5");
  });

  it("maps optional fields to the snake_case body", async () => {
    await startThread({
      config,
      message: stubMessage("5", "100"),
      name: "thread",
      options: { autoArchiveDuration: 1440, rateLimitPerUser: 10 },
    });
    const [, , , body] = startThreadFromMessageMock.mock.calls.at(0) ?? [];
    expect(body?.auto_archive_duration).toBe(1440);
    expect(body?.rate_limit_per_user).toBe(10);
  });
});

describe("createThread", () => {
  it("opens a public standalone thread and returns its id", async () => {
    const id = await createThread({
      config,
      channelId: "200",
      name: "General",
    });
    expect(id).toBe("standalone-thread");
    const [, channelId, body] = startChannelThreadMock.mock.calls.at(0) ?? [];
    expect(channelId).toBe("200");
    expect(body?.name).toBe("General");
    expect(body?.type).toBe(11);
  });

  it("opens a private thread when options.private is set", async () => {
    await createThread({
      config,
      channelId: "200",
      name: "Secret",
      options: { private: true, invitable: false },
    });
    const [, , body] = startChannelThreadMock.mock.calls.at(0) ?? [];
    expect(body?.type).toBe(12);
    expect(body?.invitable).toBe(false);
  });
});
