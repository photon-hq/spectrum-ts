import type {
  AdvancedIMessage,
  GroupChange,
  GroupEvent,
  GroupIcon,
} from "@photon-ai/advanced-imessage";
import { NotFoundError } from "@photon-ai/advanced-imessage";
import { describe, expect, it, vi } from "vitest";
import { toGroupEventMessages } from "@/remote/group-events";

const OCCURRED_AT = new Date(1_700_000_000_000);
const GROUP_GUID = "iMessage;+;chat123";
const PHONE = "+15551234567";

// Non-icon change kinds never touch the client.
const NO_CLIENT = {} as AdvancedIMessage;

const groupEvent = (
  change: unknown,
  overrides: Partial<GroupEvent> = {}
): GroupEvent =>
  ({
    actor: { address: "actor@example.com" },
    chatGuid: GROUP_GUID,
    change: change as GroupChange,
    isFromMe: false,
    occurredAt: OCCURRED_AT,
    sequence: 7,
    type: "group.changed",
    ...overrides,
  }) as unknown as GroupEvent;

const clientWithIcon = (getIcon: (chat: string) => Promise<GroupIcon>) => {
  const getIconMock = vi.fn(getIcon);
  const client = {
    groups: { getIcon: getIconMock },
  } as unknown as AdvancedIMessage;
  return { client, getIconMock };
};

describe("iMessage remote toGroupEventMessages", () => {
  it("maps participantAdded to addMember with the actor as sender", async () => {
    const messages = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent(
        {
          type: "participantAdded",
          participant: { address: "+15550100" },
        },
        {
          actor: {
            address: "+15557654321",
            country: "ca",
            service: "iMessage",
          },
        } as Partial<GroupEvent>
      ),
      PHONE
    );

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.id).toBe(`${GROUP_GUID}:group:7`);
    expect(message?.content).toEqual({
      type: "addMember",
      members: ["+15550100"],
    });
    expect(message?.sender).toEqual({
      id: "+15557654321",
      address: "+15557654321",
      country: "ca",
      service: "iMessage",
    });
    expect(message?.space).toEqual({
      id: GROUP_GUID,
      type: "group",
      phone: PHONE,
    });
    expect(message?.timestamp).toEqual(OCCURRED_AT);
  });

  it("maps participantRemoved to removeMember", async () => {
    const messages = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent({
        type: "participantRemoved",
        participant: { address: "+15550100" },
      }),
      PHONE
    );

    expect(messages[0]?.content).toEqual({
      type: "removeMember",
      members: ["+15550100"],
    });
    expect(messages[0]?.sender?.id).toBe("actor@example.com");
  });

  it("emits an actor-less membership change with sender undefined", async () => {
    // Unlike reactions (dropped when actor-less — the actor is the
    // substance), the membership change itself is the payload.
    const messages = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent(
        { type: "participantAdded", participant: { address: "+15550100" } },
        { actor: undefined }
      ),
      PHONE
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content.type).toBe("addMember");
    expect(messages[0]?.sender).toBeUndefined();
  });

  it("maps participantLeft to leaveSpace with the leaver as sender, ignoring the actor", async () => {
    const messages = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent(
        { type: "participantLeft", participant: { address: "+15550100" } },
        {
          actor: { address: "someone-else@example.com" },
        } as Partial<GroupEvent>
      ),
      PHONE
    );

    expect(messages[0]?.content).toEqual({ type: "leaveSpace" });
    expect(messages[0]?.sender?.id).toBe("+15550100");
  });

  it("maps an actor-less participantLeft to the leaver", async () => {
    const messages = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent(
        { type: "participantLeft", participant: { address: "+15550100" } },
        { actor: undefined }
      ),
      PHONE
    );

    expect(messages[0]?.sender?.id).toBe("+15550100");
  });

  it("drops add/remove events whose participant has no address", async () => {
    const messages = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent({ type: "participantAdded", participant: {} }),
      PHONE
    );

    expect(messages).toEqual([]);
  });

  it("maps displayNameChanged to rename and drops an empty name", async () => {
    const renamed = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent({ type: "displayNameChanged", displayName: "Ski Trip" }),
      PHONE
    );
    expect(renamed[0]?.content).toEqual({
      type: "rename",
      displayName: "Ski Trip",
    });

    const cleared = await toGroupEventMessages(
      NO_CLIENT,
      groupEvent({ type: "displayNameChanged", displayName: "" }),
      PHONE
    );
    expect(cleared).toEqual([]);
  });

  it("maps iconChanged to an avatar set carrying the fetched icon", async () => {
    const { client, getIconMock } = clientWithIcon(() =>
      Promise.resolve({
        data: new TextEncoder().encode("icon-bytes"),
        mimeType: "image/png",
      })
    );

    const messages = await toGroupEventMessages(
      client,
      groupEvent({ type: "iconChanged" }),
      PHONE
    );

    expect(getIconMock).toHaveBeenCalledWith(GROUP_GUID);
    const content = messages[0]?.content;
    expect(content?.type).toBe("avatar");
    if (content?.type !== "avatar" || content.action.kind !== "set") {
      throw new Error("expected an avatar set action");
    }
    expect(content.action.mimeType).toBe("image/png");
    expect((await content.action.read()).toString()).toBe("icon-bytes");
  });

  it("drops iconChanged when the icon is already gone or the fetch fails", async () => {
    const missing = clientWithIcon(() =>
      Promise.reject(
        new NotFoundError("no icon", {
          code: "groupIconNotFound",
          grpcCode: 5,
          retryable: false,
        })
      )
    );
    expect(
      await toGroupEventMessages(
        missing.client,
        groupEvent({ type: "iconChanged" }),
        PHONE
      )
    ).toEqual([]);

    const failing = clientWithIcon(() =>
      Promise.reject(new Error("transport exploded"))
    );
    expect(
      await toGroupEventMessages(
        failing.client,
        groupEvent({ type: "iconChanged" }),
        PHONE
      )
    ).toEqual([]);
  });

  it("maps iconRemoved to an avatar clear without fetching", async () => {
    const { client, getIconMock } = clientWithIcon(() =>
      Promise.reject(new Error("must not be called"))
    );

    const messages = await toGroupEventMessages(
      client,
      groupEvent({ type: "iconRemoved" }),
      PHONE
    );

    expect(getIconMock).not.toHaveBeenCalled();
    expect(messages[0]?.content).toEqual({
      type: "avatar",
      action: { kind: "clear" },
    });
  });
});
