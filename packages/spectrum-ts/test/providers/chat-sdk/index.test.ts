import { describe, expect, it } from "bun:test";
import type { SpectrumLike } from "@/platform/types";
import { chatThread, getBot, messageMeta } from "@/providers/chat-sdk";
import type { ChatBot, ChatThread } from "@/providers/chat-sdk/types";
import type { Message } from "@/types/message";
import type { Space } from "@/types/space";

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

describe("getBot", () => {
  it("returns the bot off the ChatSDK runtime client", () => {
    const bot = { initialize: () => Promise.resolve() } as unknown as ChatBot;
    const app = {
      __internal: {
        platforms: new Map([["ChatSDK", { client: { bot } }]]),
      },
    } as unknown as SpectrumLike;
    expect(getBot(app)).toBe(bot);
  });

  it("returns undefined when ChatSDK is not registered", () => {
    const app = {
      __internal: { platforms: new Map() },
    } as unknown as SpectrumLike;
    expect(getBot(app)).toBeUndefined();
  });
});
