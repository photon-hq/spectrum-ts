import type {
  AdvancedIMessage,
  GroupEvent,
  SingleServiceAddressInfo,
} from "@photon-ai/advanced-imessage";
import type { Content } from "@spectrum-ts/core";
import {
  addMemberSchema,
  avatarSchema,
  createLogger,
  errorAttrs,
  leaveSpaceSchema,
  removeMemberSchema,
  renameSchema,
} from "@spectrum-ts/core/authoring";
import type { IMessageMessage } from "../types";
import { getIcon } from "./avatar";
import { chatTypeFromGuid } from "./ids";
import { toSenderRef } from "./inbound";

const log = createLogger("spectrum.imessage.group");

/**
 * Synthetic id for a `group.changed` event — shared between the stream item
 * (the dedup key across live/catch-up) and the surfaced message. `sequence`
 * is monotonic per line, so the id is unique across all change kinds.
 */
export const groupEventMessageId = (event: GroupEvent): string =>
  `${event.chatGuid}:group:${event.sequence}`;

/**
 * The acting party of a group change. For `participantLeft` that is the
 * leaver (`change.participant`) — nobody leaves on someone else's behalf
 * (third-party removal is `participantRemoved`), and `leaveSpace` content
 * carries no members, so the leaver's identity can only travel on
 * `message.sender`. Every other change acts through `event.actor`, which the
 * platform doesn't always record.
 */
export const groupEventActor = (
  event: GroupEvent
): SingleServiceAddressInfo | undefined =>
  event.change.type === "participantLeft"
    ? event.change.participant
    : event.actor;

// `toSenderRef(undefined)` fabricates `{id: ""}` — branch explicitly so an
// unrecorded actor surfaces as `sender: undefined` on the message.
const toOptionalSenderRef = (
  addr: SingleServiceAddressInfo | undefined
): ReturnType<typeof toSenderRef> | undefined =>
  addr?.address ? toSenderRef(addr) : undefined;

// The event carries no image bytes, so snapshot the icon eagerly — one RPC
// per (rare) icon change, and the bytes match the event rather than whatever
// the icon is by the time a consumer calls `read()`. A missing icon (already
// replaced or removed by fetch time) or a fetch failure drops the event; a
// follow-up `iconRemoved`/`iconChanged` carries the current state.
const fetchIconContent = async (
  client: AdvancedIMessage,
  event: GroupEvent
): Promise<Content | undefined> => {
  try {
    const icon = await getIcon(client, event.chatGuid);
    if (!icon) {
      return;
    }
    return avatarSchema.parse({
      type: "avatar",
      action: {
        kind: "set",
        mimeType: icon.mimeType,
        read: () => Promise.resolve(icon.data),
      },
    });
  } catch (e) {
    log.error(
      "failed to fetch changed group icon",
      {
        "spectrum.imessage.group.chat": event.chatGuid,
        ...errorAttrs(e),
      },
      e
    );
    return;
  }
};

const toGroupChangeContent = async (
  client: AdvancedIMessage,
  event: GroupEvent
): Promise<Content | undefined> => {
  const change = event.change;
  switch (change.type) {
    case "participantAdded":
      return change.participant.address
        ? addMemberSchema.parse({
            type: "addMember",
            members: [change.participant.address],
          })
        : undefined;
    case "participantRemoved":
      return change.participant.address
        ? removeMemberSchema.parse({
            type: "removeMember",
            members: [change.participant.address],
          })
        : undefined;
    case "participantLeft":
      return leaveSpaceSchema.parse({ type: "leaveSpace" });
    case "displayNameChanged":
      // Apple can clear a group name; `rename` requires non-empty, so a
      // name-removal event is dropped.
      return change.displayName
        ? renameSchema.parse({
            type: "rename",
            displayName: change.displayName,
          })
        : undefined;
    case "iconChanged":
      return await fetchIconContent(client, event);
    case "iconRemoved":
      return avatarSchema.parse({ type: "avatar", action: { kind: "clear" } });
    default:
      // Forward-compat: change kinds from a newer SDK are skipped.
      return;
  }
};

/**
 * Convert a `group.changed` event into inbound spectrum messages. Unlike
 * reactions — where an event without an actor is dropped because the actor
 * is itself the substance — membership/rename/avatar changes surface even
 * when the platform recorded no actor: the state change is the payload, so
 * the message ships with `sender: undefined`.
 */
export const toGroupEventMessages = async (
  client: AdvancedIMessage,
  event: GroupEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  const content = await toGroupChangeContent(client, event);
  if (!content) {
    return [];
  }
  return [
    {
      // No `direction`: the stream path defaults provider records to inbound
      // (the agent's own echoes are suppressed before conversion).
      id: groupEventMessageId(event),
      content,
      sender: toOptionalSenderRef(groupEventActor(event)),
      space: {
        id: event.chatGuid,
        type: chatTypeFromGuid(event.chatGuid),
        phone,
      },
      timestamp: event.occurredAt,
    },
  ];
};
