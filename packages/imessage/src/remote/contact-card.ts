import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { toChatGuid } from "./ids";

/**
 * Share the local account's native contact card (name + photo) with the chat.
 *
 * The SDK exposes a single chat-level `chats.shareContactInfo(chatGuid)` — the
 * card shared is always the bot account's own, so there is no payload beyond
 * the chat. `send` has already resolved the space into `spaceId` by the time
 * the dispatcher reaches here.
 *
 * On-demand and unconditional: unlike the proactive `ContactShareTracker` in
 * `contact-share.ts` (24h dedupe, gated behind the `imessageSynced` profile),
 * this fires every time the caller asks.
 */
export const shareContactCard = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.chats.shareContactInfo(toChatGuid(spaceId));
};
