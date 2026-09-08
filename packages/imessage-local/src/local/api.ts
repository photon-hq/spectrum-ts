import type { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content, ManagedStream } from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";
import type { IMessageMessage } from "../types";
import { messages as localMessages } from "./inbound";
import {
  getLocalAttachment,
  getLocalDisplayName,
  getLocalMessage,
} from "./lookup";
import { send as sendLocalMessage } from "./send";

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  localMessages(client);

export const send = (
  client: IMessageSDK,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> => sendLocalMessage(client, spaceId, content);

export const getMessage = (
  client: IMessageSDK,
  spaceId: string,
  id: string
): Promise<IMessageMessage | undefined> => getLocalMessage(client, spaceId, id);

export const getAttachment = getLocalAttachment;
export const getDisplayName = getLocalDisplayName;
