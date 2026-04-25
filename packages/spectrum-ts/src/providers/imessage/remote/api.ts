import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import type { Content } from "../../../content/types";
import type { SendResult } from "../../../platform/types";
import type { ManagedStream } from "../../../utils/stream";
import type { IMessageMessage } from "../types";
import { firstRemoteClient, primaryRemoteClient } from "./client";
import { getMessage as getRemoteMessage } from "./inbound";
import { reactToMessage as reactToRemoteMessage } from "./reactions";
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
  clients: AdvancedIMessage[]
): ManagedStream<IMessageMessage> => remoteMessages(clients);

/** Best-effort no-op when firstRemoteClient(clients) is unavailable. */
export const startTyping = async (
  clients: AdvancedIMessage[],
  spaceId: string
): Promise<void> => {
  const remote = firstRemoteClient(clients);
  if (!remote) {
    return;
  }
  await startRemoteTyping(remote, spaceId);
};

/** Best-effort no-op when firstRemoteClient(clients) is unavailable. */
export const stopTyping = async (
  clients: AdvancedIMessage[],
  spaceId: string
): Promise<void> => {
  const remote = firstRemoteClient(clients);
  if (!remote) {
    return;
  }
  await stopRemoteTyping(remote, spaceId);
};

/** Throws when primaryRemoteClient(clients) is unavailable. */
export const send = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  content: Content
): Promise<SendResult> =>
  sendRemoteMessage(primaryRemoteClient(clients), spaceId, content);

/** Throws when primaryRemoteClient(clients) is unavailable. */
export const replyToMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string,
  content: Content
): Promise<SendResult> =>
  replyToRemoteMessage(primaryRemoteClient(clients), spaceId, msgId, content);

/** Throws when primaryRemoteClient(clients) is unavailable. */
export const editMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string,
  content: Content
): Promise<void> =>
  editRemoteMessage(primaryRemoteClient(clients), spaceId, msgId, content);

/** Best-effort no-op when firstRemoteClient(clients) is unavailable. */
export const reactToMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  target: IMessageMessage,
  reaction: string
): Promise<void> => {
  const remote = firstRemoteClient(clients);
  if (!remote) {
    return;
  }
  await reactToRemoteMessage(remote, spaceId, target, reaction);
};

/** Best-effort undefined when firstRemoteClient(clients) is unavailable. */
export const getMessage = async (
  clients: AdvancedIMessage[],
  spaceId: string,
  msgId: string
): Promise<IMessageMessage | undefined> => {
  const remote = firstRemoteClient(clients);
  if (!remote) {
    return;
  }
  return getRemoteMessage(remote, spaceId, msgId);
};
