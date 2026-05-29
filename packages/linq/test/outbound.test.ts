import { describe, expect, it } from "bun:test";
import {
  attachment,
  type Message,
  poll,
  reaction,
  reply,
  text,
  voice,
} from "spectrum-ts";
import type { LinqClient } from "../src/client";
import { configSchema } from "../src/config";
import { send } from "../src/outbound/send";
import { resolveSpace } from "../src/space";
import type { LinqOutboundMessage } from "../src/types";

interface Call {
  args: unknown[];
  method: string;
}

const setup = () => {
  const calls: Call[] = [];
  const log = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };
  const client: LinqClient = {
    createChat: (input) => {
      log("createChat", input);
      return Promise.resolve({ chatId: "chat-new", messageId: "m-new" });
    },
    sendMessage: (chatId, message) => {
      log("sendMessage", chatId, message);
      return Promise.resolve({ messageId: "m-1" });
    },
    uploadAttachment: (input) => {
      log("uploadAttachment", input);
      return Promise.resolve({
        attachmentId: "att-1",
        downloadUrl: "https://cdn.test/att-1",
      });
    },
    sendVoicememo: (chatId, input) => {
      log("sendVoicememo", chatId, input);
      return Promise.resolve({ voiceMemoId: "vm-1" });
    },
    addReaction: (messageId, input) => {
      log("addReaction", messageId, input);
      return Promise.resolve();
    },
    editMessage: (messageId, input) => {
      log("editMessage", messageId, input);
      return Promise.resolve();
    },
    startTyping: (chatId) => {
      log("startTyping", chatId);
      return Promise.resolve();
    },
    stopTyping: (chatId) => {
      log("stopTyping", chatId);
      return Promise.resolve();
    },
    updateChat: (chatId, input) => {
      log("updateChat", chatId, input);
      return Promise.resolve();
    },
    downloadMedia: (url) => {
      log("downloadMedia", url);
      return Promise.resolve(Buffer.alloc(0));
    },
  };
  const map = new Map<string, unknown>([["linq.client", client]]);
  const store = {
    get: (key: string) => map.get(key),
    set: (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
  return { calls, store };
};

const config = configSchema.parse({ apiKey: "k" });
const chatSpace = { id: "chat-1" };
const stubTarget = {
  id: "tgt-1",
  content: { type: "text", text: "x" },
} as unknown as Message;

const find = (calls: Call[], method: string) =>
  calls.find((call) => call.method === method);

describe("send — message-producing content", () => {
  it("sends text as a single text part", async () => {
    const { calls, store } = setup();
    const result = await send({
      space: chatSpace,
      content: await text("hi").build(),
      config,
      store,
    });
    expect(result?.id).toBe("m-1");
    expect(result?.space.id).toBe("chat-1");
    const call = find(calls, "sendMessage");
    expect(call?.args[0]).toBe("chat-1");
    expect((call?.args[1] as LinqOutboundMessage).parts).toEqual([
      { type: "text", value: "hi" },
    ]);
  });

  it("uploads an attachment and references it by attachment_id", async () => {
    const { calls, store } = setup();
    await send({
      space: chatSpace,
      content: await attachment(Buffer.from("data"), {
        mimeType: "image/png",
        name: "p.png",
      }).build(),
      config,
      store,
    });
    const upload = find(calls, "uploadAttachment");
    expect(upload?.args[0]).toMatchObject({
      filename: "p.png",
      contentType: "image/png",
    });
    const sent = find(calls, "sendMessage");
    expect((sent?.args[1] as LinqOutboundMessage).parts).toEqual([
      { type: "media", attachmentId: "att-1" },
    ]);
  });

  it("threads a reply via reply_to", async () => {
    const { calls, store } = setup();
    await send({
      space: chatSpace,
      content: await reply("hey", stubTarget).build(),
      config,
      store,
    });
    const sent = find(calls, "sendMessage");
    const message = sent?.args[1] as LinqOutboundMessage;
    expect(message.replyTo).toEqual({ messageId: "tgt-1" });
    expect(message.parts).toEqual([{ type: "text", value: "hey" }]);
  });
});

describe("send — voice & reactions", () => {
  it("sends voice as a voice memo and returns its id", async () => {
    const { calls, store } = setup();
    const result = await send({
      space: chatSpace,
      content: await voice(Buffer.from("aud"), {
        mimeType: "audio/m4a",
        name: "v.m4a",
      }).build(),
      config,
      store,
    });
    expect(result?.id).toBe("vm-1");
    const memo = find(calls, "sendVoicememo");
    expect(memo?.args[0]).toBe("chat-1");
    expect(memo?.args[1]).toEqual({ attachmentId: "att-1" });
  });

  it("maps a heart emoji to the love tapback and returns undefined", async () => {
    const { calls, store } = setup();
    const result = await send({
      space: chatSpace,
      content: await reaction("❤️", stubTarget).build(),
      config,
      store,
    });
    expect(result).toBeUndefined();
    const react = find(calls, "addReaction");
    expect(react?.args[0]).toBe("tgt-1");
    expect(react?.args[1]).toEqual({ operation: "add", type: "love" });
  });
});

describe("send — unsupported & proactive", () => {
  it("throws UnsupportedError for polls", async () => {
    const { store } = setup();
    const content = await poll("Q?", "a", "b").build();
    await expect(
      send({ space: chatSpace, content, config, store })
    ).rejects.toThrow();
  });

  it("creates a chat on the first send to a recipient-only space", async () => {
    const { calls, store } = setup();
    const space = await resolveSpace({
      input: { users: [{ id: "+15551112222" }] },
      config: configSchema.parse({ apiKey: "k", defaultFrom: "+15559998888" }),
    });
    const result = await send({
      space,
      content: await text("first!").build(),
      config,
      store,
    });
    expect(result?.id).toBe("m-new");
    expect(result?.space.id).toBe("chat-new");
    const create = find(calls, "createChat");
    expect(create?.args[0]).toMatchObject({
      from: "+15559998888",
      to: ["+15551112222"],
    });
  });
});
