import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { toChatGuid } from "./ids";

export const startTyping = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.chats.setTyping(toChatGuid(spaceId), true);
};

export const stopTyping = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.chats.setTyping(toChatGuid(spaceId), false);
};
