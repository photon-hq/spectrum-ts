import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { toChatGuid } from "./ids";

/**
 * Mark every unread message in the chat as read.
 *
 * The SDK exposes only a chat-level `chats.markRead(chatGuid)` — there is no
 * per-message API. The `Read` content's `target` is used by the caller to
 * derive the chat, which `send` has already resolved into `spaceId` by the
 * time the dispatcher reaches here.
 */
export const markRead = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.chats.markRead(toChatGuid(spaceId));
};
