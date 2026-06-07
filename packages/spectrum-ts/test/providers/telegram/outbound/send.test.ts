import { describe, expect, it } from "bun:test";
import { attachment } from "@/content/attachment";
import { poll } from "@/content/poll";
import { reaction } from "@/content/reaction";
import { reply } from "@/content/reply";
import { text } from "@/content/text";
import type { Content } from "@/content/types";
import { voice } from "@/content/voice";
import type { TelegramClient } from "@/providers/telegram/client";
import { configSchema } from "@/providers/telegram/config";
import { send } from "@/providers/telegram/outbound/send";
import type { SentMessage, TelegramSendSpec } from "@/providers/telegram/types";
import type { Message } from "@/types/message";

const TS_SEC = 1_700_000_000;
const config = configSchema.parse({ botToken: "1:abc" });
const space = { id: "100" };
const target = {
  id: "42",
  content: { type: "text", text: "x" },
} as unknown as Message;

const setup = () => {
  const calls: TelegramSendSpec[] = [];
  const client: TelegramClient = {
    botId: "1",
    call: <T = SentMessage>(spec: TelegramSendSpec): Promise<T> => {
      calls.push(spec);
      return Promise.resolve({ message_id: 555, date: TS_SEC } as unknown as T);
    },
    download: () => Promise.resolve(Buffer.alloc(0)),
  };
  const map = new Map<string, unknown>([["telegram.client", client]]);
  const store = {
    get: (key: string) => map.get(key),
    set: (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
  return { calls, store };
};

describe("send — messages", () => {
  it("sends text as sendMessage with the chat id", async () => {
    const { calls, store } = setup();
    const result = await send({
      space,
      content: await text("hi").build(),
      config,
      store,
    });
    expect(result?.id).toBe("555");
    expect(result?.space.id).toBe("100");
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.params).toEqual({ chat_id: "100", text: "hi" });
  });

  it("sends an image attachment via sendPhoto", async () => {
    const { calls, store } = setup();
    await send({
      space,
      content: await attachment(Buffer.from("img"), {
        mimeType: "image/png",
        name: "p.png",
      }).build(),
      config,
      store,
    });
    expect(calls[0]?.method).toBe("sendPhoto");
    expect(calls[0]?.file?.field).toBe("photo");
    expect(calls[0]?.file?.filename).toBe("p.png");
    expect(calls[0]?.params.chat_id).toBe("100");
  });

  it("sends a non-image attachment via sendDocument", async () => {
    const { calls, store } = setup();
    await send({
      space,
      content: await attachment(Buffer.from("d"), {
        mimeType: "application/pdf",
        name: "d.pdf",
      }).build(),
      config,
      store,
    });
    expect(calls[0]?.method).toBe("sendDocument");
    expect(calls[0]?.file?.field).toBe("document");
  });

  it("sends voice via sendVoice", async () => {
    const { calls, store } = setup();
    await send({
      space,
      content: await voice(Buffer.from("a"), {
        mimeType: "audio/ogg",
        name: "v.ogg",
      }).build(),
      config,
      store,
    });
    expect(calls[0]?.method).toBe("sendVoice");
    expect(calls[0]?.file?.field).toBe("voice");
  });

  it("threads a reply via reply_parameters", async () => {
    const { calls, store } = setup();
    await send({
      space,
      content: await reply("hey", target).build(),
      config,
      store,
    });
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.params).toEqual({
      chat_id: "100",
      text: "hey",
      reply_parameters: { message_id: 42 },
    });
  });

  it("fans a group out to one message per item, returning the last", async () => {
    const { calls, store } = setup();
    const group = {
      type: "group",
      items: [
        { id: "a", content: await text("one").build() },
        { id: "b", content: await text("two").build() },
      ],
    } as unknown as Content;
    const result = await send({ space, content: group, config, store });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params).toMatchObject({ text: "one" });
    expect(calls[1]?.params).toMatchObject({ text: "two" });
    expect(result?.id).toBe("555");
  });

  it("passes custom content straight to the named Bot API method", async () => {
    const { calls, store } = setup();
    const custom = {
      type: "custom",
      raw: { method: "sendDice", params: { emoji: "🎲" } },
    } as unknown as Content;
    await send({ space, content: custom, config, store });
    expect(calls[0]?.method).toBe("sendDice");
    expect(calls[0]?.params).toEqual({ chat_id: "100", emoji: "🎲" });
  });
});

describe("send — fire-and-forget", () => {
  it("sends a reaction via setMessageReaction and returns undefined", async () => {
    const { calls, store } = setup();
    const result = await send({
      space,
      content: await reaction("👍", target).build(),
      config,
      store,
    });
    expect(result).toBeUndefined();
    expect(calls[0]?.method).toBe("setMessageReaction");
    expect(calls[0]?.params).toEqual({
      chat_id: "100",
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  it("rejects an invalid reaction emoji without calling the API", async () => {
    const { calls, store } = setup();
    await expect(
      send({
        space,
        content: await reaction("🚀", target).build(),
        config,
        store,
      })
    ).rejects.toThrow("not an allowed");
    expect(calls).toHaveLength(0);
  });

  it("starts a typing action; stop is a no-op", async () => {
    const { calls, store } = setup();
    await send({
      space,
      content: { type: "typing", state: "start" } as unknown as Content,
      config,
      store,
    });
    expect(calls[0]?.method).toBe("sendChatAction");
    expect(calls[0]?.params).toEqual({ chat_id: "100", action: "typing" });

    const stop = setup();
    await send({
      space,
      content: { type: "typing", state: "stop" } as unknown as Content,
      config,
      store: stop.store,
    });
    expect(stop.calls).toHaveLength(0);
  });

  it("edits text via editMessageText and rejects non-text edits", async () => {
    const { calls, store } = setup();
    await send({
      space,
      content: {
        type: "edit",
        content: { type: "text", text: "new" },
        target,
      } as unknown as Content,
      config,
      store,
    });
    expect(calls[0]?.method).toBe("editMessageText");
    expect(calls[0]?.params).toEqual({
      chat_id: "100",
      message_id: 42,
      text: "new",
    });

    await expect(
      send({
        space,
        content: {
          type: "edit",
          content: { type: "richlink", url: "https://x.test" },
          target,
        } as unknown as Content,
        config,
        store,
      })
    ).rejects.toThrow();
  });
});

describe("send — unsupported", () => {
  it("throws UnsupportedError for polls", async () => {
    const { store } = setup();
    await expect(
      send({
        space,
        content: await poll("Q?", "a", "b").build(),
        config,
        store,
      })
    ).rejects.toThrow();
  });
});
