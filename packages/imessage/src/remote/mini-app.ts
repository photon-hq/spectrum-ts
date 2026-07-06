import type {
  AdvancedIMessage,
  MiniAppCardSession,
  MiniAppMessageResult,
} from "@photon-ai/advanced-imessage";
import type { Content } from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";
import type { SpectrumMiniApp } from "./app";
import { toChatGuid } from "./ids";

const toMiniAppRecord = (
  spaceId: string,
  message: MiniAppMessageResult,
  recordContent: Content
): ProviderMessageRecord => ({
  id: message.guid,
  content: recordContent,
  direction: "outbound",
  miniAppCardSession: message.miniAppCardSession,
  space: { id: spaceId },
  timestamp: message.dateCreated,
});

/**
 * Send a server-managed Spectrum mini-app card to a remote iMessage chat.
 *
 * This uses Advanced iMessage's `SendMiniAppMessage` path, so Spectrum's
 * extension identity stays server-managed instead of being duplicated in this
 * provider.
 */
export const sendMiniApp = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: SpectrumMiniApp,
  recordContent: Content
): Promise<ProviderMessageRecord> => {
  const chat = toChatGuid(spaceId);
  const message = await remote.messages.sendMiniApp(chat, content);
  return toMiniAppRecord(spaceId, message, recordContent);
};

export const updateMiniApp = async (
  remote: AdvancedIMessage,
  spaceId: string,
  session: MiniAppCardSession,
  content: SpectrumMiniApp,
  recordContent: Content
): Promise<ProviderMessageRecord> => {
  const message = await remote.messages.updateMiniApp(session, content);
  return toMiniAppRecord(spaceId, message, recordContent);
};
