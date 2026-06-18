import { describe, expect, it } from "bun:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { imessage } from "@/index";
import type { RemoteClient } from "@/types";
import { SHARED_PHONE } from "@/types";

const SHARED_GROUP_ERROR = /shared mode cannot create group chats/;
const MULTI_CLIENT_ERROR = /params\.phone.*\+15550100, \+15550111/;
const LOCAL_MODE_ERROR = /local mode/;

const def = imessage.config({}).__definition;

const ctx = {
  config: {} as never,
  store: undefined as never,
};

// Fake remote whose chats.create issues server guids; throws when a path is
// not supposed to reach the API at all.
const fakeRemote = (
  onCreate?: (addresses: string[]) => { guid: string; isGroup: boolean }
) =>
  ({
    chats: {
      create: (addresses: string[]) => {
        if (!onCreate) {
          return Promise.reject(
            new Error("chats.create should not have been called")
          );
        }
        return Promise.resolve({ chat: onCreate(addresses) });
      },
    },
  }) as unknown as AdvancedIMessage;

const clients = (
  entries: [
    phone: string,
    onCreate?: (addresses: string[]) => { guid: string; isGroup: boolean },
  ][]
): RemoteClient[] =>
  entries.map(([phone, onCreate]) => ({ phone, client: fakeRemote(onCreate) }));

describe("imessage space.create", () => {
  it("shared mode: builds the deterministic DM guid without an API call", async () => {
    const client = clients([[SHARED_PHONE]]);
    await expect(
      def.space.create({
        ...ctx,
        client,
        input: { users: [{ id: "+15550123" }] },
      })
    ).resolves.toEqual({
      id: "any;-;+15550123",
      type: "dm",
      phone: SHARED_PHONE,
    });
  });

  it("shared mode: cannot create group chats", async () => {
    const client = clients([[SHARED_PHONE]]);
    await expect(
      def.space.create({
        ...ctx,
        client,
        input: { users: [{ id: "a@x.com" }, { id: "b@x.com" }] },
      })
    ).rejects.toThrow(SHARED_GROUP_ERROR);
  });

  it("dedicated mode: creates a DM through the API and uses the server guid", async () => {
    const client = clients([
      [
        "+15550100",
        (addresses) => ({ guid: `any;-;${addresses[0]}`, isGroup: false }),
      ],
    ]);
    await expect(
      def.space.create({
        ...ctx,
        client,
        input: { users: [{ id: "+15550123" }] },
      })
    ).resolves.toEqual({
      id: "any;-;+15550123",
      type: "dm",
      phone: "+15550100",
    });
  });

  it("dedicated mode: creates a group through the API and uses the server guid", async () => {
    const client = clients([
      ["+15550100", () => ({ guid: "iMessage;+;chat42", isGroup: true })],
    ]);
    await expect(
      def.space.create({
        ...ctx,
        client,
        input: { users: [{ id: "a@x.com" }, { id: "b@x.com" }] },
      })
    ).resolves.toEqual({
      id: "iMessage;+;chat42",
      type: "group",
      phone: "+15550100",
    });
  });

  it("dedicated mode: routes creation to the client owning params.phone", async () => {
    const client = clients([
      ["+15550100"],
      ["+15550111", () => ({ guid: "iMessage;+;chat7", isGroup: true })],
    ]);
    await expect(
      def.space.create({
        ...ctx,
        client,
        input: {
          users: [{ id: "a@x.com" }, { id: "b@x.com" }],
          params: { phone: "+15550111" },
        },
      })
    ).resolves.toEqual({
      id: "iMessage;+;chat7",
      type: "group",
      phone: "+15550111",
    });
  });
});

describe("imessage space.get", () => {
  it("constructs the space offline, deriving dm type from the guid shape", async () => {
    const client = clients([[SHARED_PHONE]]);
    await expect(
      def.space.get?.({ ...ctx, client, input: { id: "any;-;+15550123" } })
    ).resolves.toEqual({
      id: "any;-;+15550123",
      type: "dm",
      phone: SHARED_PHONE,
    });
  });

  it("derives group type from the `;+;` guid separator", async () => {
    const client = clients([["+15550100"]]);
    await expect(
      def.space.get?.({ ...ctx, client, input: { id: "iMessage;+;chat42" } })
    ).resolves.toEqual({
      id: "iMessage;+;chat42",
      type: "group",
      phone: "+15550100",
    });
  });

  it("tags the space with params.phone when provided", async () => {
    const client = clients([["+15550100"], ["+15550111"]]);
    await expect(
      def.space.get?.({
        ...ctx,
        client,
        input: { id: "any;-;a@x.com", params: { phone: "+15550111" } },
      })
    ).resolves.toEqual({
      id: "any;-;a@x.com",
      type: "dm",
      phone: "+15550111",
    });
  });

  it("requires params.phone when multiple clients are configured", async () => {
    const client = clients([["+15550100"], ["+15550111"]]);
    await expect(
      def.space.get?.({ ...ctx, client, input: { id: "any;-;x" } })
    ).rejects.toThrow(MULTI_CLIENT_ERROR);
  });

  it("is unsupported in local mode", async () => {
    const localClient = Object.create(IMessageSDK.prototype) as IMessageSDK;
    await expect(
      def.space.get?.({ ...ctx, client: localClient, input: { id: "any;-;x" } })
    ).rejects.toThrow(LOCAL_MODE_ERROR);
  });
});
