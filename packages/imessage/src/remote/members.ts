import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { AddMember, RemoveMember } from "@spectrum-ts/core";
import { toChatGuid } from "./ids";

/**
 * Apply an `AddMember` content value to a remote iMessage group chat.
 * Fire-and-forget — the `Chat` returned by `addParticipants` is discarded.
 * The caller (`handleAddMember` in the iMessage provider) is responsible
 * for the group-only / remote-only guards.
 */
export const addParticipants = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: AddMember
): Promise<void> => {
  await remote.groups.addParticipants(toChatGuid(spaceId), content.members);
};

/**
 * Apply a `RemoveMember` content value to a remote iMessage group chat.
 * Fire-and-forget — the `Chat` returned by `removeParticipants` is
 * discarded.
 */
export const removeParticipants = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: RemoveMember
): Promise<void> => {
  await remote.groups.removeParticipants(toChatGuid(spaceId), content.members);
};

/**
 * Make the agent's own account leave a remote iMessage group chat.
 * Fire-and-forget.
 */
export const leaveGroup = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.groups.leave(toChatGuid(spaceId));
};
