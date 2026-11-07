import { type Message, typing } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { send } from "@/messages";
import type { WhatsAppClients } from "@/types";

const SPACE = "15551234567";

const inbound = (
  id: string,
  content: unknown = { type: "text", text: "hi" },
  spaceId = SPACE
) =>
  ({
    id,
    content,
    direction: "inbound",
    space: { id: spaceId },
  }) as unknown as Message;

const fakeClients = (markRead = vi.fn(() => Promise.resolve())) => ({
  clients: [{ messages: { markRead } }] as unknown as WhatsAppClients,
  markRead,
});

const sendTyping = async (
  clients: WhatsAppClients,
  state: "start" | "stop",
  target?: Message
) => await send(clients, SPACE, await typing(state, target).build());

describe("whatsapp send — typing", () => {
  it("marks the target read with a typing indicator", async () => {
    const { clients, markRead } = fakeClients();

    const result = await sendTyping(clients, "start", inbound("wamid.TEXT1"));

    expect(result).toBeUndefined();
    expect(markRead).toHaveBeenCalledWith("wamid.TEXT1", {
      typingIndicator: true,
    });
  });

  it("anchors a group item on its parent wamid", async () => {
    const { clients, markRead } = fakeClients();

    await sendTyping(clients, "start", inbound("wamid.CONTACTS1:1"));

    expect(markRead).toHaveBeenCalledWith("wamid.CONTACTS1", {
      typingIndicator: true,
    });
  });

  it("no-ops without a target", async () => {
    const { clients, markRead } = fakeClients();

    await sendTyping(clients, "start");

    expect(markRead).not.toHaveBeenCalled();
  });

  it("matches a space id written with a leading +", async () => {
    const { clients, markRead } = fakeClients();

    await send(
      clients,
      `+${SPACE}`,
      await typing("start", inbound("wamid.TEXT1")).build()
    );

    expect(markRead).toHaveBeenCalledWith("wamid.TEXT1", {
      typingIndicator: true,
    });
  });

  it("no-ops on a target from another chat", async () => {
    const { clients, markRead } = fakeClients();
    const otherChat = inbound("wamid.OTHER", undefined, "15559990000");

    await sendTyping(clients, "start", otherChat);

    expect(markRead).not.toHaveBeenCalled();
  });

  it("no-ops on a partial target with no space", async () => {
    const { clients, markRead } = fakeClients();
    const partial = {
      id: "wamid.TEXT1",
      content: { type: "text", text: "hi" },
      direction: "inbound",
    } as unknown as Message;

    await expect(
      sendTyping(clients, "start", partial)
    ).resolves.toBeUndefined();
    expect(markRead).not.toHaveBeenCalled();
  });

  it.each([
    ["reaction", { type: "reaction", emoji: "\u{1F44D}" }],
    ["reaction removal", { type: "unsend" }],
    ["system event", { type: "custom", raw: { whatsapp_type: "system" } }],
    ["unknown event", { type: "custom", raw: { whatsapp_type: "unknown" } }],
  ])("no-ops on a %s, which Meta can't mark read", async (_, content) => {
    const { clients, markRead } = fakeClients();

    await sendTyping(clients, "start", inbound("wamid.EVT1", content));

    expect(markRead).not.toHaveBeenCalled();
  });

  it("no-ops on stop, since Meta has no call to dismiss the bubble", async () => {
    const { clients, markRead } = fakeClients();

    await sendTyping(clients, "stop", inbound("wamid.TEXT1"));

    expect(markRead).not.toHaveBeenCalled();
  });

  it("does not let a Meta failure reach responding()", async () => {
    const markRead = vi.fn(() => Promise.reject(new Error("message too old")));
    const { clients } = fakeClients(markRead);

    await expect(
      sendTyping(clients, "start", inbound("wamid.TEXT1"))
    ).resolves.toBeUndefined();
    expect(markRead).toHaveBeenCalledOnce();
  });
});
