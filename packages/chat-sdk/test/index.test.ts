import { describe, expect, it } from "bun:test";
import type { Message, Space } from "@spectrum-ts/core";
import { chatThread, messageMeta } from "@/index";
import type { ChatThread } from "@/types";

describe("messageMeta", () => {
  it("fills defaults for a plain message", () => {
    const meta = messageMeta({} as Message);
    expect(meta).toEqual({
      isMention: false,
      edited: false,
      editedAt: undefined,
      links: [],
    });
  });

  it("surfaces the enrichment declared on the message", () => {
    const editedAt = new Date("2026-03-03T00:00:00.000Z");
    const message = {
      isMention: true,
      edited: true,
      editedAt,
      links: [{ url: "https://x.test" }],
    } as unknown as Message;
    expect(messageMeta(message)).toEqual({
      isMention: true,
      edited: true,
      editedAt,
      links: [{ url: "https://x.test" }],
    });
  });
});

describe("chatThread", () => {
  it("returns the live thread when the space carries one", () => {
    const thread = { id: "T1" } as ChatThread;
    expect(chatThread({ thread } as unknown as Space)).toBe(thread);
  });

  it("returns undefined for an id-only space", () => {
    expect(chatThread({ id: "T1" } as unknown as Space)).toBeUndefined();
  });
});
