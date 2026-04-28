import type { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { ManagedStream } from "../../../utils/stream";
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
