import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { Rename } from "@spectrum-ts/core";
import { toChatGuid } from "./ids";

/**
 * Apply a `Rename` content value to a remote iMessage group chat.
 * Fire-and-forget — the `Chat` returned by `setDisplayName` is discarded.
 */
export const setDisplayName = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Rename
): Promise<void> => {
  await remote.groups.setDisplayName(toChatGuid(spaceId), content.displayName);
};
