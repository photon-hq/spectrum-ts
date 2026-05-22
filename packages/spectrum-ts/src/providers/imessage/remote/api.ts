import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { ManagedStream } from "../../../utils/stream";
import type { Background } from "../content/background";
import type { IMessageMessage, RemoteClient } from "../types";
import { setBackground as setRemoteBackground } from "./background";
import { getMessage as getRemoteMessage } from "./inbound";
import { reactToMessage as reactToRemoteMessage } from "./reactions";
import { markRead as markRemoteRead } from "./read";
import {
  editMessage as editRemoteMessage,
  replyToMessage as replyToRemoteMessage,
  send as sendRemoteMessage,
} from "./send";
import { messages as remoteMessages } from "./stream";
import {
  startTyping as startRemoteTyping,
  stopTyping as stopRemoteTyping,
} from "./typing";

export const messages = (
  clients: RemoteClient[]
): ManagedStream<IMessageMessage> => remoteMessages(clients);

export const setBackground = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Background
): Promise<void> => setRemoteBackground(remote, spaceId, content);

export const markRead = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await markRemoteRead(remote, spaceId);
};

export const startTyping = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await startRemoteTyping(remote, spaceId);
};

export const stopTyping = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<void> => {
  await stopRemoteTyping(remote, spaceId);
};

export const send = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> =>
  sendRemoteMessage(remote, spaceId, content);

export const replyToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content
): Promise<ProviderMessageRecord> =>
  replyToRemoteMessage(remote, spaceId, msgId, content);

export const editMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  content: Content
): Promise<void> => editRemoteMessage(remote, spaceId, msgId, content);

export const reactToMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<void> => {
  await reactToRemoteMessage(remote, spaceId, target, reaction);
};

export const getMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  phone: string
): Promise<IMessageMessage | undefined> =>
  getRemoteMessage(remote, spaceId, msgId, phone);
