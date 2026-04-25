import {
  type AdvancedIMessage,
  AuthenticationError,
  IMessageError,
  NotFoundError,
  type PollEvent,
  ValidationError,
} from "@photon-ai/advanced-imessage";
import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  type ResumableStreamItem,
  resumableOrderedStream,
} from "../../../utils/resumable-stream";
import {
  type ManagedStream,
  mergeStreams,
  stream,
} from "../../../utils/stream";
import { getMessageCache, getPollCache, type PollCache } from "../cache";
import type { IMessageMessage } from "../types";
import {
  type AppleMessage,
  type ReceivedEvent,
  receivedEventFromMessage,
  toInboundMessages,
} from "./inbound";
import { cachePollEvent, toPollDeltaMessages } from "./polls";
import { toReactionMessages } from "./reactions";

const pollRetryDelay = (delayMs: number): number => Math.random() * delayMs;

const isRetryableIMessageStreamError = (error: unknown): boolean => {
  if (
    error instanceof AuthenticationError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError
  ) {
    return false;
  }
  if (error instanceof IMessageError) {
    return true;
  }
  return false;
};

const toMessageItem = async (
  client: AdvancedIMessage,
  event: ReceivedEvent,
  cursor?: string
): Promise<ResumableStreamItem<IMessageMessage>> => {
  const id = event.message.guid as string;
  if (event.message.isFromMe) {
    return { cursor, id, values: [] };
  }

  const cache = getMessageCache(client);
  const target = event.message.associatedMessageGuid as string | undefined;
  const values = target
    ? await toReactionMessages(client, cache, event, target)
    : await toInboundMessages(client, cache, event);
  return { cursor, id, values };
};

const messageStream = (
  client: AdvancedIMessage
): ManagedStream<IMessageMessage> =>
  resumableOrderedStream<ReceivedEvent, AppleMessage, IMessageMessage>({
    fetchMissed: (cursor, { limit }) =>
      client.messages.fetchMissed(cursor, { limit }),
    isRetryableError: isRetryableIMessageStreamError,
    processLive: (event) => toMessageItem(client, event, event.cursor),
    processMissed: (message) =>
      toMessageItem(client, receivedEventFromMessage(message)),
    subscribeLive: () => client.messages.subscribe("message.received"),
  });

const logPollStreamError = (error: unknown) => {
  // Isolate the poll stream: failures here must not kill the cursor-backed
  // message stream. Poll events have no SDK cursor, so retry best-effort
  // without catch-up.
  console.error("[spectrum-ts][imessage][poll] stream failed", error);
};

const emitPollMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: PollEvent,
  emit: (message: IMessageMessage) => Promise<void>
): Promise<void> => {
  cachePollEvent(pollCache, event);
  if (event.actor.isFromMe) {
    return;
  }
  const messages = await toPollDeltaMessages(client, pollCache, event);
  for (const vote of messages) {
    await emit(vote);
  }
};

const runPollSubscription = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  subscription: ReturnType<AdvancedIMessage["polls"]["subscribe"]>,
  emit: (message: IMessageMessage) => Promise<void>,
  onEvent: () => void
): Promise<void> => {
  for await (const event of subscription) {
    onEvent();
    await emitPollMessages(client, pollCache, event, emit);
  }
};

const pollStream = (
  client: AdvancedIMessage,
  pollCache: PollCache
): ManagedStream<IMessageMessage> =>
  stream<IMessageMessage>((emit, end) => {
    let active = client.polls.subscribe();
    let closed = false;
    let retryDelayMs = RECONNECT_INITIAL_DELAY_MS;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeSleep: (() => void) | undefined;

    const sleep = async (delayMs: number): Promise<void> => {
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wakeSleep = resolve;
        sleepTimer = setTimeout(resolve, pollRetryDelay(delayMs));
      });
      sleepTimer = undefined;
      wakeSleep = undefined;
    };

    const cancelSleep = () => {
      if (sleepTimer) {
        clearTimeout(sleepTimer);
        sleepTimer = undefined;
      }
      wakeSleep?.();
      wakeSleep = undefined;
    };

    const pump = (async () => {
      while (!closed) {
        try {
          await runPollSubscription(client, pollCache, active, emit, () => {
            retryDelayMs = RECONNECT_INITIAL_DELAY_MS;
          });
        } catch (e) {
          if (!closed) {
            logPollStreamError(e);
          }
        } finally {
          await active.close();
        }

        if (!closed) {
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, RECONNECT_MAX_DELAY_MS);
          active = client.polls.subscribe();
        }
      }
      end();
    })();

    return async () => {
      closed = true;
      cancelSleep();
      await active.close();
      await pump;
    };
  });

const clientStream = (
  client: AdvancedIMessage,
  pollCache: PollCache
): ManagedStream<IMessageMessage> => {
  return mergeStreams([messageStream(client), pollStream(client, pollCache)]);
};

export const messages = (
  clients: AdvancedIMessage[]
): ManagedStream<IMessageMessage> => {
  const pollCache = getPollCache(clients);
  return mergeStreams(clients.map((client) => clientStream(client, pollCache)));
};
