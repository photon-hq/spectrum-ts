import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { dmAddress, toChatGuid } from "./ids";

/**
 * Send a Find My location-sharing request card into a remote iMessage chat.
 *
 * Scoped to 1:1 chats: the recipient is the other participant, parsed from the
 * DM chat guid via `dmAddress`. Fire-and-forget — the `LocationRequestReceipt`
 * the SDK returns is ignored (no message id is produced).
 */
export const requestLocation = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  const chat = toChatGuid(spaceId);
  await remote.locations.request(chat, dmAddress(chat));
};
