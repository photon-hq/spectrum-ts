import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type {
  Avatar,
  Content,
  ManagedStream,
  ProjectData,
  Rename,
  StreamText,
} from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";
import type { Background } from "../content/background";
import type { CustomizedMiniApp } from "../content/customized-mini-app";
import type { IMessageMessage, RemoteClient } from "../types";
import { setIcon as setRemoteIcon } from "./avatar";
import { setBackground as setRemoteBackground } from "./background";
import { sendCustomizedMiniApp as sendRemoteCustomizedMiniApp } from "./customized-mini-app";
import { getMessage as getRemoteMessage } from "./inbound";
import {
  reactToMessage as reactToRemoteMessage,
  unsendReaction as unsendRemoteReaction,
} from "./reactions";
import { markRead as markRemoteRead } from "./read";
import { setDisplayName as setRemoteDisplayName } from "./rename";
import {
  editMessage as editRemoteMessage,
  replyToMessage as replyToRemoteMessage,
  send as sendRemoteMessage,
  unsendMessage as unsendRemoteMessage,
} from "./send";
import { messages as remoteMessages } from "./stream";
import { sendStreamText as sendRemoteStreamText } from "./stream-text";
import {
  startTyping as startRemoteTyping,
  stopTyping as stopRemoteTyping,
} from "./typing";

export const messages = (
  clients: RemoteClient[],
  projectConfig: ProjectData | undefined
): ManagedStream<IMessageMessage> => remoteMessages(clients, projectConfig);

export const setBackground = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Background
): Promise<void> => setRemoteBackground(remote, spaceId, content);

export const sendCustomizedMiniApp = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: CustomizedMiniApp
): Promise<ProviderMessageRecord> =>
  sendRemoteCustomizedMiniApp(remote, spaceId, content);

export const setDisplayName = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Rename
): Promise<void> => setRemoteDisplayName(remote, spaceId, content);

export const setIcon = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Avatar
): Promise<void> => setRemoteIcon(remote, spaceId, content);

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

export const sendStreamText = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: StreamText
): Promise<ProviderMessageRecord> =>
  sendRemoteStreamText(remote, spaceId, content);

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
): Promise<ProviderMessageRecord> =>
  reactToRemoteMessage(remote, spaceId, target, reaction);

export const unsendMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string
): Promise<void> => unsendRemoteMessage(remote, spaceId, msgId);

export const unsendReaction = async (
  remote: AdvancedIMessage,
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<void> => unsendRemoteReaction(remote, spaceId, target, reaction);

export const getMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  phone: string
): Promise<IMessageMessage | undefined> =>
  getRemoteMessage(remote, spaceId, msgId, phone);
