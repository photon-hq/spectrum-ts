import { type AdvancedIMessage, chatGuid } from "@photon-ai/advanced-imessage";

export const startTyping = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.chats.startTyping(chatGuid(spaceId));
};

export const stopTyping = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await remote.chats.stopTyping(chatGuid(spaceId));
};
