import {
  type AdvancedIMessage,
  NotFoundError,
} from "@photon-ai/advanced-imessage/grpc";
import type { AvatarData } from "@spectrum-ts/core";
import { describe, expect, it, vi } from "vitest";
import { imessage } from "@/index";
import { getIcon as remoteGetIcon } from "@/remote/avatar";
import {
  type IMessageParticipant,
  listParticipants as remoteListParticipants,
} from "@/remote/members";
import { getDisplayName as remoteGetDisplayName } from "@/remote/rename";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const GROUP_ONLY_ERROR = /only group chats/;

const GROUP_GUID = "iMessage;+;chat42";
const DM_GUID = "any;-;+15550123";
const SELF_PHONE = "+15550100";

const PARTICIPANTS = [
  { address: SELF_PHONE, service: "iMessage" },
  { address: "+15550111", country: "US", service: "SMS" },
  { address: "carol@example.com", service: "iMessage" },
];

const noIconError = () =>
  new NotFoundError("group icon not found", {
    code: "groupIconNotFound",
    grpcCode: 5,
    retryable: false,
  });

const def = imessage.config({}).__definition;
const getMembersAction = def.actions?.getMembers;
const getAvatarAction = def.actions?.getAvatar;
const getDisplayNameAction = def.actions?.getDisplayName;
if (!(getMembersAction && getAvatarAction && getDisplayNameAction)) {
  throw new Error(
    "iMessage must declare the getMembers/getAvatar/getDisplayName actions"
  );
}

const ctx = {
  config: {} as never,
  store: undefined as never,
};

interface TestSpace {
  __platform: string;
  id: string;
  phone: string;
  type: "dm" | "group";
}

// `__definition` erases action signatures to `InstanceActionFn`
// (`Promise<unknown>`), so these helpers re-assert the concrete return types
// the provider declares.
const callGetMembers = (client: unknown, space: TestSpace) =>
  getMembersAction({ ...ctx, client }, space) as Promise<
    readonly IMessageParticipant[]
  >;

const callGetAvatar = (client: unknown, space: TestSpace) =>
  getAvatarAction({ ...ctx, client }, space) as Promise<AvatarData | undefined>;

const callGetDisplayName = (client: unknown, space: TestSpace) =>
  getDisplayNameAction({ ...ctx, client }, space) as Promise<
    string | undefined
  >;

interface ResourcesMock {
  chats?: { get?: (chat: string) => Promise<unknown> };
  groups?: { getIcon?: (chat: string) => Promise<unknown> };
}

const clientWith = (phone: string, resources: ResourcesMock): RemoteClient => ({
  phone,
  client: resources as unknown as AdvancedIMessage,
});

describe("iMessage remote read wrappers", () => {
  it("listParticipants forwards the guid and filters the agent's own handle", async () => {
    const get = vi.fn((_chat: string) =>
      Promise.resolve({ participants: PARTICIPANTS })
    );
    const remote = { chats: { get } } as unknown as AdvancedIMessage;

    const members = await remoteListParticipants(
      remote,
      GROUP_GUID,
      SELF_PHONE
    );

    expect(get).toHaveBeenCalledWith(GROUP_GUID);
    expect(members).toEqual([
      { id: "+15550111", address: "+15550111", country: "US", service: "SMS" },
      {
        id: "carol@example.com",
        address: "carol@example.com",
        country: undefined,
        service: "iMessage",
      },
    ]);
  });

  it("getIcon copies bytes into a Buffer and maps groupIconNotFound to undefined", async () => {
    const getIcon = vi.fn((_chat: string) =>
      Promise.resolve({
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      })
    );
    const remote = { groups: { getIcon } } as unknown as AdvancedIMessage;

    const icon = await remoteGetIcon(remote, GROUP_GUID);

    expect(getIcon).toHaveBeenCalledWith(GROUP_GUID);
    expect(icon?.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(icon?.data)).toBe(true);
    expect(Array.from(icon?.data ?? [])).toEqual([1, 2, 3]);

    const missing = {
      groups: { getIcon: () => Promise.reject(noIconError()) },
    } as unknown as AdvancedIMessage;
    expect(await remoteGetIcon(missing, GROUP_GUID)).toBeUndefined();
  });

  it("getDisplayName forwards the guid and normalizes an empty name to undefined", async () => {
    const get = vi.fn((_chat: string) =>
      Promise.resolve({ displayName: "Team Chat", participants: PARTICIPANTS })
    );
    const remote = { chats: { get } } as unknown as AdvancedIMessage;

    expect(await remoteGetDisplayName(remote, GROUP_GUID)).toBe("Team Chat");
    expect(get).toHaveBeenCalledWith(GROUP_GUID);

    const unnamed = {
      chats: { get: () => Promise.resolve({ displayName: "" }) },
    } as unknown as AdvancedIMessage;
    expect(await remoteGetDisplayName(unnamed, GROUP_GUID)).toBeUndefined();
  });
});

describe("iMessage actions.getMembers", () => {
  it("lists group participants, excluding the agent's own number", async () => {
    const get = vi.fn((_chat: string) =>
      Promise.resolve({ participants: PARTICIPANTS })
    );
    const client = [clientWith(SELF_PHONE, { chats: { get } })];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    const members = await callGetMembers(client, space);

    expect(get).toHaveBeenCalledWith(GROUP_GUID);
    expect(members.map((m) => m.id)).toEqual([
      "+15550111",
      "carol@example.com",
    ]);
  });

  it("returns the full roster in shared mode (sentinel never matches)", async () => {
    const get = vi.fn((_chat: string) =>
      Promise.resolve({ participants: PARTICIPANTS })
    );
    const client = [clientWith(SHARED_PHONE, { chats: { get } })];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SHARED_PHONE,
      __platform: "imessage",
    } as const;

    const members = await callGetMembers(client, space);

    expect(members).toHaveLength(3);
  });

  it("rejects DMs", async () => {
    const client = [clientWith(SELF_PHONE, {})];
    const space = {
      id: DM_GUID,
      type: "dm",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    await expect(callGetMembers(client, space)).rejects.toThrow(
      GROUP_ONLY_ERROR
    );
  });

  it("routes by space.phone across multiple clients", async () => {
    const wrongGet = vi.fn((_chat: string) =>
      Promise.resolve({ participants: [] })
    );
    const rightGet = vi.fn((_chat: string) =>
      Promise.resolve({ participants: PARTICIPANTS })
    );
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: "+15550200",
      __platform: "imessage",
    } as const;

    await callGetMembers(
      [
        clientWith(SELF_PHONE, { chats: { get: wrongGet } }),
        clientWith("+15550200", { chats: { get: rightGet } }),
      ],
      space
    );

    expect(wrongGet).not.toHaveBeenCalled();
    expect(rightGet).toHaveBeenCalledWith(GROUP_GUID);
  });
});

describe("iMessage actions.getAvatar", () => {
  it("downloads the group icon as Buffer + mimeType", async () => {
    const getIcon = vi.fn((_chat: string) =>
      Promise.resolve({ data: new Uint8Array([9, 8]), mimeType: "image/heic" })
    );
    const client = [clientWith(SELF_PHONE, { groups: { getIcon } })];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    const icon = await callGetAvatar(client, space);

    expect(getIcon).toHaveBeenCalledWith(GROUP_GUID);
    expect(icon?.mimeType).toBe("image/heic");
    expect(Buffer.isBuffer(icon?.data)).toBe(true);
    expect(Array.from(icon?.data ?? [])).toEqual([9, 8]);
  });

  it("resolves undefined when the group has no icon", async () => {
    const client = [
      clientWith(SELF_PHONE, {
        groups: { getIcon: () => Promise.reject(noIconError()) },
      }),
    ];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    expect(await callGetAvatar(client, space)).toBeUndefined();
  });

  it("propagates other NotFoundErrors (e.g. chatNotFound)", async () => {
    const client = [
      clientWith(SELF_PHONE, {
        groups: {
          getIcon: () =>
            Promise.reject(
              new NotFoundError("chat not found", {
                code: "chatNotFound",
                grpcCode: 5,
                retryable: false,
              })
            ),
        },
      }),
    ];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    await expect(callGetAvatar(client, space)).rejects.toThrow(NotFoundError);
  });

  it("rejects DMs", async () => {
    const client = [clientWith(SELF_PHONE, {})];
    const space = {
      id: DM_GUID,
      type: "dm",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    await expect(callGetAvatar(client, space)).rejects.toThrow(
      GROUP_ONLY_ERROR
    );
  });
});

describe("iMessage actions.getDisplayName", () => {
  it("returns the group's current display name", async () => {
    const get = vi.fn((_chat: string) =>
      Promise.resolve({ displayName: "Team Chat", participants: PARTICIPANTS })
    );
    const client = [clientWith(SELF_PHONE, { chats: { get } })];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    expect(await callGetDisplayName(client, space)).toBe("Team Chat");
    expect(get).toHaveBeenCalledWith(GROUP_GUID);
  });

  it("resolves undefined for an unnamed group", async () => {
    const client = [
      clientWith(SELF_PHONE, {
        chats: { get: () => Promise.resolve({ displayName: "" }) },
      }),
    ];
    const space = {
      id: GROUP_GUID,
      type: "group",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    expect(await callGetDisplayName(client, space)).toBeUndefined();
  });

  it("is unsupported for a 1:1 chat (group-only, like the other group reads)", async () => {
    const get = vi.fn((_chat: string) =>
      Promise.resolve({ displayName: "", participants: [] })
    );
    const client = [clientWith(SELF_PHONE, { chats: { get } })];
    const space = {
      id: DM_GUID,
      type: "dm",
      phone: SELF_PHONE,
      __platform: "imessage",
    } as const;

    await expect(callGetDisplayName(client, space)).rejects.toThrow(
      GROUP_ONLY_ERROR
    );
    expect(get).not.toHaveBeenCalled();
  });
});
