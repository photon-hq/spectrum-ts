import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { Content } from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";
import type { CustomizedMiniApp } from "../content/customized-mini-app";
import { toChatGuid } from "./ids";

/**
 * Send a `CustomizedMiniApp` card to a remote iMessage chat.
 *
 * Unlike `setBackground`, this produces a real outbound message, so it returns
 * a `ProviderMessageRecord`. The `content` carries extra `type` / `__platform`
 * tags the SDK ignores; it is passed as a variable (not an object literal) so
 * no excess-property check applies, and the wire serializer reads only the
 * fields it knows.
 */
export const sendCustomizedMiniApp = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: CustomizedMiniApp
): Promise<ProviderMessageRecord> => {
  const chat = toChatGuid(spaceId);
  const message = await remote.messages.sendCustomizedMiniApp(chat, content);
  return {
    id: message.guid,
    content: content as unknown as Content,
    direction: "outbound",
    space: { id: spaceId },
    timestamp: message.dateCreated,
  };
};
