import {
  type AdvancedIMessage,
  AuthenticationError,
  type CatchUpEvent,
  IMessageError,
  type MessageEvent,
  NotFoundError,
  type PollEvent,
  ValidationError,
} from "@photon-ai/advanced-imessage";
import {
  type CloseableAsyncIterable,
  type ResumableStreamItem,
  resumableOrderedStream,
} from "../../../utils/resumable-stream";
import { type ManagedStream, mergeStreams } from "../../../utils/stream";
import { getMessageCache, getPollCache, type PollCache } from "../cache";
import {
  type IMessageMessage,
  type RemoteClient,
  SHARED_PHONE,
} from "../types";
import { toInboundMessages } from "./inbound";
import { cachePollEvent, toPollDeltaMessages } from "./polls";
import { toReactionMessages } from "./reactions";

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

const isEventFromCurrentAccount = (
  event: Pick<MessageEvent | PollEvent, "actor">,
  phone: string
): boolean =>
  phone !== SHARED_PHONE &&
  event.actor?.address !== undefined &&
  event.actor.address === phone;

const toMessageItem = async (
  client: AdvancedIMessage,
  event: MessageEvent,
  phone: string,
  cursor: string
): Promise<ResumableStreamItem<IMessageMessage>> => {
  if (event.type === "message.received") {
    if (event.message.isFromMe) {
      return { cursor, id: event.message.guid, values: [] };
    }

    const cache = getMessageCache(client);
    return {
      cursor,
      id: event.message.guid,
      values: await toInboundMessages(client, cache, event, phone),
    };
  }

  if (event.type === "message.reactionAdded") {
    if (isEventFromCurrentAccount(event, phone)) {
      return {
        cursor,
        id: `${event.messageGuid}:reaction:${event.sequence}`,
        values: [],
      };
    }

    const cache = getMessageCache(client);
    return {
      cursor,
      id: `${event.messageGuid}:reaction:${event.sequence}`,
      values: await toReactionMessages(client, cache, event, phone),
    };
  }

  return {
    cursor,
    id: `${event.type}:${"messageGuid" in event ? event.messageGuid : "unknown"}:${event.sequence}`,
    values: [],
  };
};

const toPollItem = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: PollEvent,
  phone: string,
  cursor: string
): Promise<ResumableStreamItem<IMessageMessage>> => {
  cachePollEvent(pollCache, event);
  if (isEventFromCurrentAccount(event, phone)) {
    return {
      cursor,
      id: `${event.pollMessageGuid}:poll:${event.sequence}`,
      values: [],
    };
  }

  return {
    cursor,
    id: `${event.pollMessageGuid}:poll:${event.sequence}`,
    values: await toPollDeltaMessages(client, pollCache, event, phone),
  };
};

const toCatchUpCompleteItem = (
  event: Extract<CatchUpEvent, { type: "catchup.complete" }>
): ResumableStreamItem<IMessageMessage> => ({
  cursor: String(event.headSequence),
  id: `${event.type}:${event.headSequence}`,
  values: [],
});

type CatchUpCompleteEvent = Extract<CatchUpEvent, { type: "catchup.complete" }>;
type MessageCatchUpEvent = MessageEvent | CatchUpCompleteEvent;
type PollCatchUpEvent = PollEvent | CatchUpCompleteEvent;

const isMessageEvent = (event: CatchUpEvent): event is MessageEvent =>
  event.type.startsWith("message.");

const isPollEvent = (event: CatchUpEvent): event is PollEvent =>
  event.type === "poll.changed";

async function* catchUpEvents<T extends MessageEvent | PollEvent>(
  client: AdvancedIMessage,
  cursor: string,
  isWanted: (event: CatchUpEvent) => event is T
): AsyncGenerator<T | CatchUpCompleteEvent> {
  const since = toResumeAfter(cursor);
  if (since === undefined) {
    return;
  }

  for await (const event of client.events.catchUp(since)) {
    if (event.type === "catchup.complete") {
      yield event;
      return;
    }
    if (isWanted(event)) {
      yield event;
    }
  }
}

const toResumeAfter = (cursor: string | undefined): number | undefined => {
  if (!cursor) {
    return;
  }
  const sequence = Number(cursor);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
};

async function* afterCursor(
  stream: CloseableAsyncIterable<MessageEvent | PollEvent>,
  cursor?: string
): AsyncGenerator<MessageEvent | PollEvent> {
  const resumeAfter = toResumeAfter(cursor);
  try {
    for await (const event of stream) {
      if (resumeAfter !== undefined && event.sequence <= resumeAfter) {
        continue;
      }
      yield event;
    }
  } finally {
    await stream.close?.();
  }
}

const withClose = <T extends MessageEvent | PollEvent>(
  source: CloseableAsyncIterable<T>,
  cursor?: string
): CloseableAsyncIterable<T> =>
  Object.assign(afterCursor(source, cursor) as AsyncGenerator<T>, {
    close: async () => {
      await source.close?.();
    },
  });

const messageStream = (
  client: AdvancedIMessage,
  phone: string
): ManagedStream<IMessageMessage> =>
  resumableOrderedStream<MessageEvent, MessageCatchUpEvent, IMessageMessage>({
    fetchMissed: (cursor) => catchUpEvents(client, cursor, isMessageEvent),
    isRetryableError: isRetryableIMessageStreamError,
    processLive: (event) =>
      toMessageItem(client, event, phone, String(event.sequence)),
    processMissed: (event) =>
      event.type === "catchup.complete"
        ? Promise.resolve(toCatchUpCompleteItem(event))
        : toMessageItem(client, event, phone, String(event.sequence)),
    subscribeLive: (cursor) =>
      withClose(client.messages.subscribeEvents(), cursor),
  });

const pollStream = (
  client: AdvancedIMessage,
  pollCache: PollCache,
  phone: string
): ManagedStream<IMessageMessage> =>
  resumableOrderedStream<PollEvent, PollCatchUpEvent, IMessageMessage>({
    fetchMissed: (cursor) => catchUpEvents(client, cursor, isPollEvent),
    isRetryableError: isRetryableIMessageStreamError,
    processLive: (event) =>
      toPollItem(client, pollCache, event, phone, String(event.sequence)),
    processMissed: (event) =>
      event.type === "catchup.complete"
        ? Promise.resolve(toCatchUpCompleteItem(event))
        : toPollItem(client, pollCache, event, phone, String(event.sequence)),
    subscribeLive: (cursor) =>
      withClose(client.polls.subscribeEvents(), cursor),
  });

const clientStream = (
  client: AdvancedIMessage,
  pollCache: PollCache,
  phone: string
): ManagedStream<IMessageMessage> =>
  mergeStreams([
    messageStream(client, phone),
    pollStream(client, pollCache, phone),
  ]);

export const messages = (
  clients: RemoteClient[]
): ManagedStream<IMessageMessage> => {
  const pollCache = getPollCache(clients);
  return mergeStreams(
    clients.map((entry) => clientStream(entry.client, pollCache, entry.phone))
  );
};
