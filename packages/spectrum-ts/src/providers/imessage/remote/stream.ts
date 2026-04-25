import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import {
  type ManagedStream,
  mergeStreams,
  stream,
} from "../../../utils/stream";
import { getMessageCache } from "../cache";
import type { IMessageMessage } from "../types";
import { toInboundMessages } from "./inbound";
import { toReactionMessages } from "./reactions";

const clientStream = (
  client: AdvancedIMessage
): ManagedStream<IMessageMessage> => {
  const sub = client.messages.subscribe("message.received");
  const cache = getMessageCache(client);
  return stream<IMessageMessage>((emit, end) => {
    const pump = (async () => {
      try {
        for await (const event of sub) {
          if (event.message.isFromMe) {
            continue;
          }
          const target = event.message.associatedMessageGuid as
            | string
            | undefined;
          const messages = target
            ? await toReactionMessages(client, cache, event, target)
            : await toInboundMessages(client, cache, event);
          for (const message of messages) {
            await emit(message);
          }
        }
        end();
      } catch (e) {
        end(e);
      }
    })();
    return async () => {
      sub.close();
      await pump;
    };
  });
};

export const messages = (
  clients: AdvancedIMessage[]
): ManagedStream<IMessageMessage> => mergeStreams(clients.map(clientStream));
