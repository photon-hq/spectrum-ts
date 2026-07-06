import { describe, expect, it } from "vitest";
import { edit } from "@/content/edit";
import {
  type AddMember,
  addMember,
  type LeaveSpace,
  leaveSpace,
  type RemoveMember,
  removeMember,
} from "@/content/membership";
import { reply } from "@/content/reply";
import type { Message } from "@/types/message";
import type { User } from "@/types/user";

const EMPTY_ADD = /addMember\(\) requires at least one member/;
const EMPTY_REMOVE = /removeMember\(\) requires at least one member/;
const REPLY_CANNOT_WRAP_ADD = /reply\(\) cannot wrap "addMember"/;
const REPLY_CANNOT_WRAP_REMOVE = /reply\(\) cannot wrap "removeMember"/;
const REPLY_CANNOT_WRAP_LEAVE = /reply\(\) cannot wrap "leaveSpace"/;
const EDIT_CANNOT_WRAP_ADD = /edit\(\) cannot wrap "addMember"/;
const EDIT_CANNOT_WRAP_REMOVE = /edit\(\) cannot wrap "removeMember"/;
const EDIT_CANNOT_WRAP_LEAVE = /edit\(\) cannot wrap "leaveSpace"/;

const makeMessage = (direction: "inbound" | "outbound"): Message =>
  ({
    id: "m1",
    content: { type: "text", text: "hi" },
    direction,
  }) as unknown as Message;

const alice: User = { __platform: "test", id: "+15550100" };
const bob: User = { __platform: "test", id: "bob@example.com" };

describe("membership builders", () => {
  it("addMember builds from a single id string", async () => {
    const built = (await addMember("+15550100").build()) as AddMember;

    expect(built.type).toBe("addMember");
    expect(built.members).toEqual(["+15550100"]);
  });

  it("addMember normalizes a single User to its id", async () => {
    const built = (await addMember(alice).build()) as AddMember;

    expect(built.members).toEqual([alice.id]);
  });

  it("addMember normalizes a mixed User/string array", async () => {
    const built = (await addMember([
      alice,
      "carol@example.com",
      bob,
    ]).build()) as AddMember;

    expect(built.members).toEqual([alice.id, "carol@example.com", bob.id]);
  });

  it("addMember rejects an empty array at build time", async () => {
    await expect(addMember([]).build()).rejects.toThrow(EMPTY_ADD);
  });

  it("removeMember builds from a single id string", async () => {
    const built = (await removeMember("+15550100").build()) as RemoveMember;

    expect(built.type).toBe("removeMember");
    expect(built.members).toEqual(["+15550100"]);
  });

  it("removeMember normalizes a mixed User/string array", async () => {
    const built = (await removeMember([
      bob,
      "+15550101",
    ]).build()) as RemoveMember;

    expect(built.members).toEqual([bob.id, "+15550101"]);
  });

  it("removeMember rejects an empty array at build time", async () => {
    await expect(removeMember([]).build()).rejects.toThrow(EMPTY_REMOVE);
  });

  it("leaveSpace builds a payload-free value", async () => {
    const built = (await leaveSpace().build()) as LeaveSpace;

    expect(built).toEqual({ type: "leaveSpace" });
  });

  it("cannot be wrapped by reply()", async () => {
    const target = makeMessage("inbound");
    await expect(reply(addMember("u1"), target).build()).rejects.toThrow(
      REPLY_CANNOT_WRAP_ADD
    );
    await expect(reply(removeMember("u1"), target).build()).rejects.toThrow(
      REPLY_CANNOT_WRAP_REMOVE
    );
    await expect(reply(leaveSpace(), target).build()).rejects.toThrow(
      REPLY_CANNOT_WRAP_LEAVE
    );
  });

  it("cannot be wrapped by edit()", async () => {
    const target = makeMessage("outbound");
    await expect(edit(addMember("u1"), target).build()).rejects.toThrow(
      EDIT_CANNOT_WRAP_ADD
    );
    await expect(edit(removeMember("u1"), target).build()).rejects.toThrow(
      EDIT_CANNOT_WRAP_REMOVE
    );
    await expect(edit(leaveSpace(), target).build()).rejects.toThrow(
      EDIT_CANNOT_WRAP_LEAVE
    );
  });
});
