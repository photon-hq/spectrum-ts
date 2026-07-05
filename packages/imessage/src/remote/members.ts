import type {
  AdvancedIMessage,
  ChatServiceType,
} from "@photon-ai/advanced-imessage";
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

/**
 * A group participant mapped to spectrum's user shape. `id` is the canonical
 * address (E.164 phone or email — the same handle format `space.create`
 * accepts); `address`/`country`/`service` mirror the SDK record and match
 * the extras declared by the provider's `userSchema`.
 */
// biome-ignore lint/style/useConsistentTypeDefinitions: must stay a type alias — interfaces lack the implicit index signature needed to satisfy core's `ProviderUserRecord`
export type IMessageParticipant = {
  id: string;
  address: string;
  country?: string;
  service: ChatServiceType;
};

/**
 * List a remote group chat's current participants, excluding the agent's own
 * handle (`selfPhone` — the dedicated number that owns the chat; the shared
 * sentinel never matches a canonical address, so shared mode returns the
 * full roster). The caller (`getMembers` in the iMessage provider) owns the
 * group-only / remote-only guards.
 */
export const listParticipants = async (
  remote: AdvancedIMessage,
  spaceId: string,
  selfPhone: string
): Promise<IMessageParticipant[]> => {
  const { participants } = await remote.chats.get(toChatGuid(spaceId));
  return participants
    .filter((p) => p.address !== selfPhone)
    .map((p) => ({
      id: p.address,
      address: p.address,
      country: p.country,
      service: p.service,
    }));
};
