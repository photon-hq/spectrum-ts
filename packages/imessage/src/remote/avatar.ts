import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { Avatar } from "@spectrum-ts/core";
import { toChatGuid } from "./ids";

/**
 * Apply an `Avatar` content value to a remote iMessage group chat.
 *
 * `set` uploads the icon bytes via `groups.setIcon`; `clear` removes the
 * current icon via `groups.removeIcon`. Both surfaces are fire-and-forget —
 * no message id is produced. The caller (`handleAvatar` in the iMessage
 * provider) is responsible for the group-only / remote-only guards.
 */
export const setIcon = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Avatar
): Promise<void> => {
  const chat = toChatGuid(spaceId);
  if (content.action.kind === "clear") {
    await remote.groups.removeIcon(chat);
    return;
  }
  const buffer = await content.action.read();
  await remote.groups.setIcon(
    chat,
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );
};
