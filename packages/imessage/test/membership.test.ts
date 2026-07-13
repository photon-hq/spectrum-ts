import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { addMember, leaveSpace, removeMember } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { imessage } from "@/index";
import {
  addParticipants as remoteAddParticipants,
  leaveGroup as remoteLeaveGroup,
  removeParticipants as remoteRemoveParticipants,
} from "@/remote/members";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const GROUP_ONLY_ERROR = /only group chats/;
const CREATE_GROUP_HINT = /space\.create/;

const GROUP_GUID = "iMessage;+;chat42";
const DM_GUID = "any;-;+15550123";

const def = imessage.config({}).__definition;

const ctx = {
  config: {} as never,
  store: undefined as never,
};

interface GroupsMock {
  addParticipants?: (chat: string, addresses: string[]) => Promise<unknown>;
  leave?: (chat: string) => Promise<void>;
  removeParticipants?: (chat: string, addresses: string[]) => Promise<unknown>;
}

const clientWithGroups = (phone: string, groups: GroupsMock): RemoteClient => ({
  phone,
  client: { groups } as unknown as AdvancedIMessage,
});

describe("iMessage remote members wrappers", () => {
  it("addParticipants forwards guid and members to groups.addParticipants", async () => {
    const addParticipants = vi.fn((_chat: string, _addresses: string[]) =>
      Promise.resolve({ guid: GROUP_GUID })
    );
    const remote = {
      groups: { addParticipants },
    } as unknown as AdvancedIMessage;

    await remoteAddParticipants(remote, GROUP_GUID, {
      type: "addMember",
      members: ["+15550111", "carol@example.com"],
    });

    expect(addParticipants).toHaveBeenCalledTimes(1);
    expect(addParticipants).toHaveBeenCalledWith(GROUP_GUID, [
      "+15550111",
      "carol@example.com",
    ]);
  });

  it("removeParticipants forwards guid and members to groups.removeParticipants", async () => {
    const removeParticipants = vi.fn((_chat: string, _addresses: string[]) =>
      Promise.resolve({ guid: GROUP_GUID })
    );
    const remote = {
      groups: { removeParticipants },
    } as unknown as AdvancedIMessage;

    await remoteRemoveParticipants(remote, GROUP_GUID, {
      type: "removeMember",
      members: ["+15550111"],
    });

    expect(removeParticipants).toHaveBeenCalledWith(GROUP_GUID, ["+15550111"]);
  });

  it("leaveGroup forwards the guid to groups.leave", async () => {
    const leave = vi.fn((_chat: string) => Promise.resolve());
    const remote = { groups: { leave } } as unknown as AdvancedIMessage;

    await remoteLeaveGroup(remote, GROUP_GUID);

    expect(leave).toHaveBeenCalledWith(GROUP_GUID);
  });
});

describe("iMessage send: membership dispatch", () => {
  it("routes addMember to groups.addParticipants and is fire-and-forget", async () => {
    const addParticipants = vi.fn((_chat: string, _addresses: string[]) =>
      Promise.resolve({ guid: GROUP_GUID })
    );

    const result = await def.send({
      ...ctx,
      client: [clientWithGroups(SHARED_PHONE, { addParticipants })],
      space: { id: GROUP_GUID, type: "group", phone: SHARED_PHONE },
      content: await addMember(["+15550111"]).build(),
    });

    expect(result).toBeUndefined();
    expect(addParticipants).toHaveBeenCalledWith(GROUP_GUID, ["+15550111"]);
  });

  it("routes removeMember to groups.removeParticipants and is fire-and-forget", async () => {
    const removeParticipants = vi.fn((_chat: string, _addresses: string[]) =>
      Promise.resolve({ guid: GROUP_GUID })
    );

    const result = await def.send({
      ...ctx,
      client: [clientWithGroups(SHARED_PHONE, { removeParticipants })],
      space: { id: GROUP_GUID, type: "group", phone: SHARED_PHONE },
      content: await removeMember("+15550111").build(),
    });

    expect(result).toBeUndefined();
    expect(removeParticipants).toHaveBeenCalledWith(GROUP_GUID, ["+15550111"]);
  });

  it("routes leaveSpace to groups.leave and is fire-and-forget", async () => {
    const leave = vi.fn((_chat: string) => Promise.resolve());

    const result = await def.send({
      ...ctx,
      client: [clientWithGroups(SHARED_PHONE, { leave })],
      space: { id: GROUP_GUID, type: "group", phone: SHARED_PHONE },
      content: await leaveSpace().build(),
    });

    expect(result).toBeUndefined();
    expect(leave).toHaveBeenCalledWith(GROUP_GUID);
  });

  it("rejects DMs for all three ops", async () => {
    const client = [clientWithGroups(SHARED_PHONE, {})];
    const space = { id: DM_GUID, type: "dm", phone: SHARED_PHONE } as const;

    for (const content of [
      await addMember("+15550111").build(),
      await removeMember("+15550111").build(),
      await leaveSpace().build(),
    ]) {
      await expect(
        def.send({ ...ctx, client, space, content })
      ).rejects.toThrow(GROUP_ONLY_ERROR);
    }
  });

  it("points add/remove DM rejections at space.create", async () => {
    const client = [clientWithGroups(SHARED_PHONE, {})];
    const space = { id: DM_GUID, type: "dm", phone: SHARED_PHONE } as const;

    for (const content of [
      await addMember("+15550111").build(),
      await removeMember("+15550111").build(),
    ]) {
      await expect(
        def.send({ ...ctx, client, space, content })
      ).rejects.toThrow(CREATE_GROUP_HINT);
    }
  });

  it("routes by space.phone across multiple clients", async () => {
    const wrongAdd = vi.fn((_chat: string, _addresses: string[]) =>
      Promise.resolve({ guid: GROUP_GUID })
    );
    const rightAdd = vi.fn((_chat: string, _addresses: string[]) =>
      Promise.resolve({ guid: GROUP_GUID })
    );

    await def.send({
      ...ctx,
      client: [
        clientWithGroups("+15550100", { addParticipants: wrongAdd }),
        clientWithGroups("+15550200", { addParticipants: rightAdd }),
      ],
      space: { id: GROUP_GUID, type: "group", phone: "+15550200" },
      content: await addMember("+15550111").build(),
    });

    expect(wrongAdd).not.toHaveBeenCalled();
    expect(rightAdd).toHaveBeenCalledWith(GROUP_GUID, ["+15550111"]);
  });
});
