import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import {
  attachment,
  type Content,
  type Message,
  markdown,
  poll,
  reaction,
  reply,
  text,
  voice,
} from "@spectrum-ts/core";
import { asRead } from "@spectrum-ts/core/authoring";
import { configSchema } from "@/config";
import { send } from "@/outbound/send";

const TS_SEC = 1_700_000_000;
const SYNTHETIC_REACTION_ID = /^reaction:100:42:\d+:bot:👍$/;
const config = configSchema.parse({ botToken: "1:abc" });
const space = { id: "100" };
const target = {
  id: "42",
  content: { type: "text", text: "x" },
} as unknown as Message;

interface Captured {
  contentType: string | null;
  form?: FormData;
  json?: Record<string, unknown>;
  method: string;
}

// setMessageReaction/sendChatAction/editMessageText go through photon's typed
// functions, which validate the response against a Zod schema — so the mock
// must echo their `{ ok, result: true }` shape; message sends accept any result.
const FIRE_AND_FORGET = new Set([
  "setMessageReaction",
  "sendChatAction",
  "editMessageText",
]);

const responseFor = (method: string): unknown =>
  FIRE_AND_FORGET.has(method)
    ? { ok: true, result: true }
    : { ok: true, result: { message_id: 555, date: TS_SEC } };

let calls: Captured[];

beforeEach(() => {
  calls = [];
  const impl = (input: Request): Promise<Response> => {
    const url = input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    const contentType = input.headers.get("content-type");
    const record = async (): Promise<Captured> => {
      if (contentType?.includes("application/json")) {
        return {
          contentType,
          json: (await input.clone().json()) as Record<string, unknown>,
          method,
        };
      }
      return {
        contentType,
        form: (await input.clone().formData()) as unknown as FormData,
        method,
      };
    };
    return record().then((captured) => {
      calls.push(captured);
      return Response.json(responseFor(method));
    });
  };
  spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch
  );
});

afterEach(() => {
  mock.restore();
});

describe("send — messages", () => {
  it("sends text as sendMessage with the chat id and returns the record", async () => {
    const result = await send({
      space,
      content: await text("hi").build(),
      config,
    });
    expect(result?.id).toBe("555");
    expect(result?.space.id).toBe("100");
    expect(result?.timestamp).toEqual(new Date(TS_SEC * 1000));
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.json).toEqual({ chat_id: "100", text: "hi" });
  });

  it("sends markdown as sendMessage with rendered HTML and parse_mode", async () => {
    const result = await send({
      space,
      content: await markdown("**hi**").build(),
      config,
    });
    expect(result?.id).toBe("555");
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.json).toEqual({
      chat_id: "100",
      text: "<b>hi</b>",
      parse_mode: "HTML",
    });
  });

  it("sends markdown group items with parse_mode", async () => {
    const groupContent = {
      type: "group",
      items: [
        { id: "a", content: await text("one").build() },
        { id: "b", content: await markdown("**two**").build() },
      ],
    } as unknown as Content;
    await send({ space, content: groupContent, config });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.json).toEqual({ chat_id: "100", text: "one" });
    expect(calls[1]?.json).toEqual({
      chat_id: "100",
      text: "<b>two</b>",
      parse_mode: "HTML",
    });
  });

  it("sends an image attachment via sendPhoto as multipart, preserving the filename", async () => {
    await send({
      space,
      content: await attachment(Buffer.from("img"), {
        mimeType: "image/png",
        name: "p.png",
      }).build(),
      config,
    });
    expect(calls[0]?.method).toBe("sendPhoto");
    expect(calls[0]?.contentType).not.toContain("application/json");
    expect(calls[0]?.form?.get("chat_id")).toBe("100");
    expect((calls[0]?.form?.get("photo") as File).name).toBe("p.png");
  });

  it("sends a non-image attachment via sendDocument", async () => {
    await send({
      space,
      content: await attachment(Buffer.from("d"), {
        mimeType: "application/pdf",
        name: "d.pdf",
      }).build(),
      config,
    });
    expect(calls[0]?.method).toBe("sendDocument");
    expect((calls[0]?.form?.get("document") as File).name).toBe("d.pdf");
  });

  it("sends voice via sendVoice", async () => {
    await send({
      space,
      content: await voice(Buffer.from("a"), {
        mimeType: "audio/ogg",
        name: "v.ogg",
      }).build(),
      config,
    });
    expect(calls[0]?.method).toBe("sendVoice");
    expect((calls[0]?.form?.get("voice") as File).name).toBe("v.ogg");
  });

  it("threads a reply via reply_parameters", async () => {
    await send({ space, content: await reply("hey", target).build(), config });
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.json).toEqual({
      chat_id: "100",
      text: "hey",
      reply_parameters: { message_id: 42 },
    });
  });

  it("fans a group out to one message per item, returning the last", async () => {
    const group = {
      type: "group",
      items: [
        { id: "a", content: await text("one").build() },
        { id: "b", content: await text("two").build() },
      ],
    } as unknown as Content;
    const result = await send({ space, content: group, config });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.json).toMatchObject({ text: "one" });
    expect(calls[1]?.json).toMatchObject({ text: "two" });
    expect(result?.id).toBe("555");
  });

  it("passes custom content straight to the named Bot API method", async () => {
    const custom = {
      type: "custom",
      raw: { method: "sendDice", params: { emoji: "🎲" } },
    } as unknown as Content;
    await send({ space, content: custom, config });
    expect(calls[0]?.method).toBe("sendDice");
    expect(calls[0]?.json).toEqual({ chat_id: "100", emoji: "🎲" });
  });

  it("sends a reaction via setMessageReaction and returns a synthetic record", async () => {
    const result = await send({
      space,
      content: await reaction("👍", target).build(),
      config,
    });
    expect(result?.id).toMatch(SYNTHETIC_REACTION_ID);
    expect((result?.content as { type?: string }).type).toBe("reaction");
    expect(result?.space.id).toBe("100");
    expect(result?.timestamp).toBeInstanceOf(Date);
    expect(calls[0]?.method).toBe("setMessageReaction");
    expect(calls[0]?.json).toEqual({
      chat_id: "100",
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  it("rejects an invalid reaction emoji without calling the API", async () => {
    await expect(
      send({ space, content: await reaction("🚀", target).build(), config })
    ).rejects.toThrow("not an allowed");
    expect(calls).toHaveLength(0);
  });
});

describe("send — fire-and-forget", () => {
  it("starts a typing action via sendChatAction", async () => {
    await send({
      space,
      content: { type: "typing", state: "start" } as unknown as Content,
      config,
    });
    expect(calls[0]?.method).toBe("sendChatAction");
    expect(calls[0]?.json).toEqual({ action: "typing", chat_id: "100" });
  });

  it("treats typing stop as a no-op", async () => {
    await send({
      space,
      content: { type: "typing", state: "stop" } as unknown as Content,
      config,
    });
    expect(calls).toHaveLength(0);
  });

  it("edits markdown via editMessageText with parse_mode", async () => {
    await send({
      space,
      content: {
        type: "edit",
        content: { type: "markdown", markdown: "**new**" },
        target,
      } as unknown as Content,
      config,
    });
    expect(calls[0]?.method).toBe("editMessageText");
    expect(calls[0]?.json).toEqual({
      chat_id: "100",
      message_id: 42,
      text: "<b>new</b>",
      parse_mode: "HTML",
    });
  });

  it("edits text via editMessageText", async () => {
    await send({
      space,
      content: {
        type: "edit",
        content: { type: "text", text: "new" },
        target,
      } as unknown as Content,
      config,
    });
    expect(calls[0]?.method).toBe("editMessageText");
    expect(calls[0]?.json).toEqual({
      chat_id: "100",
      message_id: 42,
      text: "new",
    });
  });

  it("rejects a non-text edit without calling the API", async () => {
    await expect(
      send({
        space,
        content: {
          type: "edit",
          content: { type: "richlink", url: "https://x.test" },
          target,
        } as unknown as Content,
        config,
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("send — read", () => {
  it("silently no-ops without calling the API (bot chats have no read receipts)", async () => {
    const result = await send({
      space,
      content: asRead({ target }),
      config,
    });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("send — unsupported", () => {
  it("throws UnsupportedError for polls", async () => {
    await expect(
      send({ space, content: await poll("Q?", "a", "b").build(), config })
    ).rejects.toThrow();
  });
});
