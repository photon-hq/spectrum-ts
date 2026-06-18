import { describe, expect, it } from "bun:test";
import type { Message } from "@spectrum-ts/core";
import { chatSDK } from "@/index";
import type { ChatAdapter } from "@/types";

const makeAdapter = (name: string): ChatAdapter =>
  ({
    name,
    initialize: () => Promise.resolve(),
    channelIdFromThreadId: (id: string) => id,
    handleWebhook: () => Promise.resolve(new Response()),
    addReaction: () => Promise.resolve(),
  }) as unknown as ChatAdapter;

describe("chatSDK factory", () => {
  it("names the platform after the adapter", () => {
    const discord = chatSDK(makeAdapter("discord"));
    expect(discord.config().__name).toBe("discord");
  });

  it("accepts an explicit name via the (name, adapter) overload", () => {
    const platform = chatSDK("discord-2", makeAdapter("discord"));
    expect(platform.config().__name).toBe("discord-2");
  });

  it("config() is valid with no arguments", () => {
    const linear = chatSDK(makeAdapter("linear"));
    // No throw, and the def is carried through for registration.
    expect(linear.config().__definition.name).toBe("linear");
  });
});

describe("chatSDK narrowing — is()", () => {
  const discord = chatSDK(makeAdapter("discord"));
  const linear = chatSDK(makeAdapter("linear"));

  const messageOn = (platform: string): Message =>
    ({
      platform,
      sender: { id: "U" },
      space: { id: "T" },
      content: { type: "text", text: "" },
    }) as unknown as Message;

  it("discriminates a message by platform name", () => {
    const discordMsg = messageOn("discord");
    expect(discord.is(discordMsg)).toBe(true);
    expect(linear.is(discordMsg)).toBe(false);
  });

  it("each adapter platform only matches its own", () => {
    const linearMsg = messageOn("linear");
    expect(linear.is(linearMsg)).toBe(true);
    expect(discord.is(linearMsg)).toBe(false);
  });
});
