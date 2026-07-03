import { describe, expect, it, vi } from "vitest";
import { configSchema } from "@/config";
import { handleMessages } from "@/inbound/messages";
import type { Update } from "@/types";

const TS_SEC = 1_700_000_000;
const DOWNLOAD = Buffer.from("file-bytes");

// botToken prefix "999" is the bot's own id — drives the self-echo test.
const config = configSchema.parse({ botToken: "999:abc" });

const update = (over: Record<string, unknown>): Update =>
  ({ update_id: 1, ...over }) as unknown as Update;

// `handleMessages` is a Fusor handler; it only reads `payload` + `config`, so a
// minimal ctx (cast to the full ctx type) is enough to exercise it.
const ctx = (over: Record<string, unknown>) =>
  ({ config, payload: update(over) }) as Parameters<typeof handleMessages>[0];

const message = (over: Record<string, unknown>): Record<string, unknown> => ({
  message_id: 5,
  date: TS_SEC,
  chat: { id: 100, type: "private" },
  from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
  ...over,
});

const handle = (over: Record<string, unknown>) =>
  handleMessages(ctx({ message: message(over) }));

describe("handleMessages — text", () => {
  it("maps a text message to text content", () => {
    const record = handle({ text: "hello" });
    expect(record?.id).toBe("5");
    expect(record?.content).toEqual({ type: "text", text: "hello" });
    expect(record?.sender?.id).toBe("7");
    expect(record?.sender?.handle).toBe("alice");
    expect(record?.space.id).toBe("100");
    expect(record?.timestamp).toEqual(new Date(TS_SEC * 1000));
  });
});

describe("handleMessages — media", () => {
  it("picks the largest photo size", () => {
    const record = handle({
      photo: [
        {
          file_id: "small",
          file_unique_id: "u1",
          width: 90,
          height: 90,
          file_size: 1000,
        },
        {
          file_id: "big",
          file_unique_id: "u2",
          width: 1280,
          height: 1280,
          file_size: 50_000,
        },
      ],
    });
    expect(record?.content.type).toBe("attachment");
    if (record?.content.type === "attachment") {
      expect(record.content.id).toBe("big");
      expect(record.content.mimeType).toBe("image/jpeg");
    }
  });

  it("maps a document with its real name and mime type", () => {
    const record = handle({
      document: {
        file_id: "doc1",
        file_unique_id: "u",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 2048,
      },
    });
    if (record?.content.type === "attachment") {
      expect(record.content.name).toBe("report.pdf");
      expect(record.content.mimeType).toBe("application/pdf");
      expect(record.content.size).toBe(2048);
    } else {
      throw new Error("expected attachment");
    }
  });

  it("maps a voice note to voice content", () => {
    const record = handle({
      voice: {
        file_id: "v1",
        file_unique_id: "u",
        duration: 3,
        mime_type: "audio/ogg",
        file_size: 999,
      },
    });
    expect(record?.content.type).toBe("voice");
    if (record?.content.type === "voice") {
      expect(record.content.mimeType).toBe("audio/ogg");
      expect(record.content.duration).toBe(3);
    }
  });

  it("maps an audio (music) file to an attachment, not voice", () => {
    const record = handle({
      audio: {
        file_id: "a1",
        file_unique_id: "u",
        duration: 200,
        mime_type: "audio/mpeg",
        file_size: 5000,
      },
    });
    expect(record?.content.type).toBe("attachment");
  });

  it("bundles caption + media into a group", () => {
    const record = handle({
      caption: "see this",
      photo: [
        {
          file_id: "p",
          file_unique_id: "u",
          width: 100,
          height: 100,
          file_size: 10,
        },
      ],
    });
    expect(record?.content.type).toBe("group");
    if (record?.content.type === "group") {
      expect(record.content.items).toHaveLength(2);
      expect(record.content.items[0]?.content.type).toBe("text");
      expect(record.content.items[1]?.content.type).toBe("attachment");
    }
  });

  it("maps an animation once even though Telegram also sets document", () => {
    const record = handle({
      animation: {
        file_id: "anim",
        file_unique_id: "ua",
        width: 1,
        height: 1,
        duration: 1,
        file_name: "g.mp4",
        mime_type: "video/mp4",
      },
      document: { file_id: "dup", file_unique_id: "ud" },
    });
    if (record?.content.type === "attachment") {
      expect(record.content.id).toBe("anim");
    } else {
      throw new Error("expected attachment");
    }
  });

  it("downloads bytes lazily through a client built inline", async () => {
    const fetched: string[] = [];
    const impl = (input: Request | string): Promise<Response> => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(url);
      if (url.endsWith("/getFile")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            result: {
              file_id: "doc-read",
              file_unique_id: "u",
              file_path: "files/f.bin",
            },
          })
        );
      }
      return Promise.resolve(new Response(DOWNLOAD));
    };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(impl as unknown as typeof fetch);
    try {
      const record = handle({
        document: {
          file_id: "doc-read",
          file_unique_id: "u",
          file_name: "f.bin",
        },
      });
      expect(fetched).toHaveLength(0); // nothing fetched on the ack path
      if (record?.content.type === "attachment") {
        const bytes = await record.content.read();
        expect(Buffer.from(bytes)).toEqual(DOWNLOAD);
        expect(fetched.some((u) => u.endsWith("/getFile"))).toBe(true);
        expect(
          fetched.some((u) => u.includes("/file/bot999:abc/files/f.bin"))
        ).toBe(true);
      } else {
        throw new Error("expected attachment");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleMessages — channel posts & self-echo", () => {
  it("maps a senderless channel post", () => {
    const record = handleMessages(
      ctx({
        channel_post: {
          message_id: 9,
          date: TS_SEC,
          chat: { id: -100, type: "channel" },
          text: "broadcast",
        },
      })
    );
    expect(record?.content).toEqual({ type: "text", text: "broadcast" });
    expect(record?.sender).toBeUndefined();
    expect(record?.space.id).toBe("-100");
  });

  it("ignores the bot's own messages", () => {
    const record = handle({
      from: { id: 999, is_bot: true, first_name: "Bot" },
      text: "my own echo",
    });
    expect(record).toBeUndefined();
  });
});

describe("handleMessages — reactions & ignored updates", () => {
  it("maps a message_reaction add to a reaction targeting the message", () => {
    const record = handleMessages(
      ctx({
        message_reaction: {
          chat: { id: 100, type: "private" },
          message_id: 5,
          user: { id: 7, is_bot: false, first_name: "Alice" },
          date: TS_SEC,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "👍" }],
        },
      })
    );
    expect(record?.content.type).toBe("reaction");
    if (record?.content.type === "reaction") {
      expect(record.content.emoji).toBe("👍");
      expect(record.content.target.id).toBe("5");
    }
    expect(record?.space.id).toBe("100");
  });

  it("ignores a reaction removal (empty new_reaction)", () => {
    const record = handleMessages(
      ctx({
        message_reaction: {
          chat: { id: 100, type: "private" },
          message_id: 5,
          date: TS_SEC,
          old_reaction: [{ type: "emoji", emoji: "👍" }],
          new_reaction: [],
        },
      })
    );
    expect(record).toBeUndefined();
  });

  it("ignores update types outside v1 scope", () => {
    expect(
      handleMessages(ctx({ edited_message: message({ text: "x" }) }))
    ).toBeUndefined();
    expect(
      handleMessages(ctx({ callback_query: { id: "cb" } }))
    ).toBeUndefined();
    expect(handleMessages(ctx({}))).toBeUndefined();
  });
});
