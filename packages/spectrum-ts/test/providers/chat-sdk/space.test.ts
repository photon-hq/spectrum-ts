import { describe, expect, it } from "bun:test";
import { chatSDK } from "@/providers/chat-sdk";
import type { ChatBot, ChatThread } from "@/providers/chat-sdk/types";

// Reach the inline def through the provider-config seam — the space/user hooks
// only touch `client.bot` and `input`, so the rest of the ctx can be stubbed.
const def = chatSDK({} as ChatBot).__definition;

const ctx = {
  config: {} as never,
  store: undefined as never,
};

const ONE_USER_ERROR = /at least one user/;

const dmThread = { id: "DM-1" } as ChatThread;
const botWithDM = {
  openDM: (user: string) => Promise.resolve({ ...dmThread, id: `dm:${user}` }),
} as unknown as ChatBot;

describe("chat-sdk space.create", () => {
  it("opens a DM with the first user and uses the thread id as the space id", async () => {
    await expect(
      def.space.create({
        ...ctx,
        client: { bot: botWithDM } as never,
        input: { users: [{ id: "U1" }] },
      })
    ).resolves.toEqual({ id: "dm:U1" });
  });

  it("requires at least one user", async () => {
    await expect(
      def.space.create({
        ...ctx,
        client: { bot: botWithDM } as never,
        input: { users: [] },
      })
    ).rejects.toThrow(ONE_USER_ERROR);
  });
});

describe("chat-sdk space.get", () => {
  it("treats the id as the space id", async () => {
    await expect(
      def.space.get?.({
        ...ctx,
        client: undefined as never,
        input: { id: "T123" },
      })
    ).resolves.toEqual({ id: "T123" });
  });
});

describe("chat-sdk user.resolve", () => {
  it("returns the userID as the user id", async () => {
    await expect(
      def.user.resolve({
        ...ctx,
        client: undefined as never,
        input: { userID: "U7" },
      })
    ).resolves.toEqual({ id: "U7" });
  });
});
