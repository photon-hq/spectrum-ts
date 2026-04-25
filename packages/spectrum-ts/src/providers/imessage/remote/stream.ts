import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import {
  type ManagedStream,
  mergeStreams,
  stream,
} from "../../../utils/stream";
import { getMessageCache, getPollCache, type PollCache } from "../cache";
import type { IMessageMessage } from "../types";
import { toInboundMessages } from "./inbound";
import { cachePollEvent, toPollDeltaMessages } from "./polls";
import { toReactionMessages } from "./reactions";

const clientStream = (
  client: AdvancedIMessage,
  pollCache: PollCache
): ManagedStream<IMessageMessage> => {
  const messageSub = client.messages.subscribe("message.received");
  const pollSub = client.polls.subscribe();
  const cache = getMessageCache(client);
  return stream<IMessageMessage>((emit, end) => {
    const messagePump = (async () => {
      try {
        for await (const event of messageSub) {
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
      } catch (e) {
        end(e);
      }
    })();
    const pollPump = (async () => {
      try {
        for await (const event of pollSub) {
          cachePollEvent(pollCache, event);
          if (event.actor.isFromMe) {
            continue;
          }
          const messages = await toPollDeltaMessages(client, pollCache, event);
          for (const vote of messages) {
            await emit(vote);
          }
        }
      } catch (e) {
        // Isolate the poll stream: a failure here (e.g. upstream SDK int64
        // parse errors on SubscribePollEvents) must not kill the message
        // stream. Log and move on: poll_option events simply won't arrive.
        console.error("[spectrum-ts][imessage][poll] stream failed", e);
      }
    })();
    return async () => {
      messageSub.close();
      pollSub.close();
      await Promise.all([messagePump, pollPump]);
    };
  });
};

export const messages = (
  clients: AdvancedIMessage[]
): ManagedStream<IMessageMessage> => {
  const pollCache = getPollCache(clients);
  return mergeStreams(clients.map((client) => clientStream(client, pollCache)));
};
