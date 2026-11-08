import { stubCloud } from "@spectrum-ts/test-support/cloud";
import {
  baseConfig,
  makeQueue,
  record,
} from "@spectrum-ts/test-support/platform";
import {
  SPECTRUM_WEBHOOK_SECRET,
  signSpectrum,
  textEnvelope,
} from "@spectrum-ts/test-support/webhook";
import { describe, expect, it } from "vitest";
import z from "zod";
import type { Content } from "@/content/types";
import { typing } from "@/content/typing";
import { definePlatform } from "@/platform/define";
import type { ProviderMessage } from "@/platform/types";
import { Spectrum } from "@/spectrum";
import type { Message } from "@/types/message";
import type { Space } from "@/types/space";

stubCloud();

process.env.SPECTRUM_WEBHOOK_SECRET = "";

const PLATFORM = "typing_test";
const OUTBOUND_TARGET_ERROR = /typing\(\) target must be an inbound message/;

type InboundRecord = ProviderMessage<{ id: string }, { id: string }>;

// A provider that emits one inbound text and records every content it is
// asked to send, so tests can inspect what the typing sugar dispatched.
const makeRecordingProvider = () => {
  const sent: Content[] = [];
  const queue = makeQueue<InboundRecord>();
  queue.push(record("m-stream-1"));
  queue.close();
  const provider = definePlatform(PLATFORM, {
    config: z.object({}),
    lifecycle: { createClient: () => Promise.resolve({}) },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
    space: {
      create: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    messages: () => queue.iter,
    send: ({ content }) => {
      sent.push(content);
      return Promise.resolve(undefined);
    },
  });
  return { provider, sent };
};

const typingSent = (sent: Content[]) =>
  sent.filter((c) => c.type === "typing") as Extract<
    Content,
    { type: "typing" }
  >[];

describe("typing sugar targets the inbound message", () => {
  it("stream: startTyping/responding carry the message the space arrived with", async () => {
    const { provider, sent } = makeRecordingProvider();
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const iterator = app.messages[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) {
        throw new Error("expected an inbound message");
      }
      const [space, message] = first.value;

      await space.responding(() => undefined);

      const typing = typingSent(sent);
      expect(typing.map((t) => t.state)).toEqual(["start", "stop"]);
      expect(typing[0]?.target).toBe(message);
      expect(typing[1]?.target).toBe(message);
    } finally {
      await app.stop();
    }
  });

  it("webhook: the handler's space targets the delivered message", async () => {
    const { provider, sent } = makeRecordingProvider();
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
      webhookSecret: SPECTRUM_WEBHOOK_SECRET,
    });
    try {
      const { promise: handled, resolve: done } =
        Promise.withResolvers<[Space, Message]>();
      await app.webhook(
        signSpectrum(textEnvelope(PLATFORM, "hello")),
        async (space, message) => {
          await space.startTyping();
          done([space, message]);
        }
      );
      const [, message] = await handled;

      const [typing] = typingSent(sent);
      expect(typing?.state).toBe("start");
      expect(typing?.target).toBe(message);
      expect(typing?.target?.id).toBe("m-webhook-1");
    } finally {
      await app.stop();
    }
  });

  it("space.send(typing()) on a received space targets its message too", async () => {
    const { provider, sent } = makeRecordingProvider();
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const iterator = app.messages[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) {
        throw new Error("expected an inbound message");
      }
      const [space, message] = first.value;

      await space.send(typing());

      const [sentTyping] = typingSent(sent);
      expect(sentTyping?.target).toBe(message);
    } finally {
      await app.stop();
    }
  });

  it("rejects an outbound target at build time, like read()", async () => {
    const outbound = { id: "m-out", direction: "outbound" } as Message;

    await expect(typing("start", outbound).build()).rejects.toThrow(
      OUTBOUND_TARGET_ERROR
    );
  });

  it("a space the app created itself sends typing without a target", async () => {
    const { provider, sent } = makeRecordingProvider();
    const app = await Spectrum({
      ...baseConfig,
      providers: [provider.config({})],
    });
    try {
      const platform = provider(app);
      const space = await platform.space.create(await platform.user("u1"));

      await space.startTyping();

      const [typing] = typingSent(sent);
      expect(typing?.state).toBe("start");
      expect(typing?.target).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});
