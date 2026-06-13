import type { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content, ManagedStream } from "@spectrum-ts/core";
import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";
import type { IMessageMessage } from "../types";
import { messages as localMessages } from "./inbound";
import {
  getMessage as getLocalMessage,
  send as sendLocalMessage,
} from "./send";

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  localMessages(client);

export const send = async (
  client: IMessageSDK,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> => sendLocalMessage(client, spaceId, content);

export const getMessage = async (
  client: IMessageSDK,
  id: string
): Promise<IMessageMessage | undefined> => getLocalMessage(client, id);
