import {
  type AdvancedIMessage,
  NotFoundError,
} from "@photon-ai/advanced-imessage/grpc";
import type { Avatar, AvatarData } from "@spectrum-ts/core";
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

/**
 * Download the current icon of a remote iMessage group chat. Resolves
 * `undefined` when the group has no icon (the SDK's `NotFoundError` with
 * code `groupIconNotFound`); any other error — including a `chatNotFound`
 * `NotFoundError` — propagates. Bytes are copied into a Buffer so the result
 * round-trips into `setIcon` / `space.avatar(...)`. The caller (`getAvatar`
 * in the iMessage provider) owns the group-only / remote-only guards.
 */
export const getIcon = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<AvatarData | undefined> => {
  try {
    const icon = await remote.groups.getIcon(toChatGuid(spaceId));
    return { data: Buffer.from(icon.data), mimeType: icon.mimeType };
  } catch (err) {
    if (err instanceof NotFoundError && err.code === "groupIconNotFound") {
      return;
    }
    throw err;
  }
};
