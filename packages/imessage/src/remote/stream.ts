import {
  type AdvancedIMessage,
  type CatchUpEvent,
  type GroupEvent,
  type MessageEvent,
  type PollEvent,
  ValidationError,
} from "@photon-ai/advanced-imessage";
import { sanitizePhone } from "@photon-ai/otel";
import {
  type ManagedStream,
  mergeStreams,
  type ProjectData,
} from "@spectrum-ts/core";
import {
  type CloseableAsyncIterable,
  type ResumableStreamItem,
  resumableOrderedStream,
} from "@spectrum-ts/core/authoring";
import { getCloudRecover } from "../auth";
import { getMessageCache, getPollCache, type PollCache } from "../cache";
import {
  type IMessageMessage,
  type RemoteClient,
  SHARED_PHONE,
} from "../types";
import { getContactShareTracker } from "./contact-share";
import {
  groupEventActor,
  groupEventMessageId,
  toGroupEventMessages,
} from "./group-events";
import { toInboundMessages } from "./inbound";
import { cachePollEvent, toPollDeltaMessages } from "./polls";
import { toReactionMessages } from "./reactions";

// The proxy rejects an unknown/pruned resume cursor with INVALID_ARGUMENT,
// which the client surfaces as ValidationError — the only ValidationError the
// catch-up RPC produces (ENG-1566).
const isCursorRejectedIMessageError = (error: unknown): boolean =>
  error instanceof ValidationError;

const streamLabel = (
  kind: "messages" | "polls" | "groups",
  phone: string
): string =>
  `imessage.${kind}:${phone === SHARED_PHONE ? phone : sanitizePhone(phone)}`;

const isEventFromCurrentAccount = (
  event: Pick<MessageEvent | PollEvent | GroupEvent, "actor" | "isFromMe">,
  phone: string
): boolean =>
  event.isFromMe ||
  (phone !== SHARED_PHONE &&
    event.actor?.address !== undefined &&
    event.actor.address === phone);

/**
 * Side effect fired when a non-self `message.received` event is converted.
 * Receives the `chatGuid` of the inbound message. Implementations must be
 * synchronous and never throw — typical use is fire-and-forget cache lookup
 * + background API call.
 */
type OnInboundMessage = (chatGuid: string) => void;

const toMessageItem = async (
  client: AdvancedIMessage,
  event: MessageEvent,
  phone: string,
  cursor: string,
  onInbound?: OnInboundMessage
): Promise<ResumableStreamItem<IMessageMessage>> => {
  if (event.type === "message.received") {
    if (event.message.isFromMe) {
      return { cursor, id: event.message.guid, values: [] };
    }

    const inboundChatGuid = event.message.chatGuids?.[0];
    if (inboundChatGuid) {
      onInbound?.(inboundChatGuid);
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

const toGroupItem = async (
  client: AdvancedIMessage,
  event: GroupEvent,
  phone: string,
  cursor: string
): Promise<ResumableStreamItem<IMessageMessage>> => {
  const id = groupEventMessageId(event);
  // Self-check against the acting party — for a leave that is the leaver
  // (`event.actor` is often absent there), so the agent's own departure via
  // `space.leave()` doesn't echo back as an inbound event.
  const actor = groupEventActor(event);
  if (isEventFromCurrentAccount({ actor, isFromMe: event.isFromMe }, phone)) {
    return { cursor, id, values: [] };
  }

  return {
    cursor,
    id,
    values: await toGroupEventMessages(client, event, phone),
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
type GroupCatchUpEvent = GroupEvent | CatchUpCompleteEvent;

const isMessageEvent = (event: CatchUpEvent): event is MessageEvent =>
  event.type.startsWith("message.");

const isPollEvent = (event: CatchUpEvent): event is PollEvent =>
  event.type === "poll.changed";

const isGroupEvent = (event: CatchUpEvent): event is GroupEvent =>
  event.type === "group.changed";

async function* catchUpEvents<T extends MessageEvent | PollEvent | GroupEvent>(
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
  stream: CloseableAsyncIterable<MessageEvent | PollEvent | GroupEvent>,
  cursor?: string
): AsyncGenerator<MessageEvent | PollEvent | GroupEvent> {
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

const withClose = <T extends MessageEvent | PollEvent | GroupEvent>(
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
  phone: string,
  onInbound?: OnInboundMessage,
  recover?: () => Promise<void>
): ManagedStream<IMessageMessage> =>
  resumableOrderedStream<MessageEvent, MessageCatchUpEvent, IMessageMessage>({
    fetchMissed: (cursor) => catchUpEvents(client, cursor, isMessageEvent),
    isCursorRejectedError: isCursorRejectedIMessageError,
    label: streamLabel("messages", phone),
    recover,
    processLive: (event) =>
      toMessageItem(client, event, phone, String(event.sequence), onInbound),
    processMissed: (event) =>
      event.type === "catchup.complete"
        ? Promise.resolve(toCatchUpCompleteItem(event))
        : toMessageItem(
            client,
            event,
            phone,
            String(event.sequence),
            onInbound
          ),
    subscribeLive: (cursor) =>
      withClose(client.messages.subscribeEvents(), cursor),
  });

const pollStream = (
  client: AdvancedIMessage,
  pollCache: PollCache,
  phone: string,
  recover?: () => Promise<void>
): ManagedStream<IMessageMessage> =>
  resumableOrderedStream<PollEvent, PollCatchUpEvent, IMessageMessage>({
    fetchMissed: (cursor) => catchUpEvents(client, cursor, isPollEvent),
    isCursorRejectedError: isCursorRejectedIMessageError,
    label: streamLabel("polls", phone),
    recover,
    processLive: (event) =>
      toPollItem(client, pollCache, event, phone, String(event.sequence)),
    processMissed: (event) =>
      event.type === "catchup.complete"
        ? Promise.resolve(toCatchUpCompleteItem(event))
        : toPollItem(client, pollCache, event, phone, String(event.sequence)),
    subscribeLive: (cursor) =>
      withClose(client.polls.subscribeEvents(), cursor),
  });

const groupStream = (
  client: AdvancedIMessage,
  phone: string,
  recover?: () => Promise<void>
): ManagedStream<IMessageMessage> =>
  resumableOrderedStream<GroupEvent, GroupCatchUpEvent, IMessageMessage>({
    fetchMissed: (cursor) => catchUpEvents(client, cursor, isGroupEvent),
    isCursorRejectedError: isCursorRejectedIMessageError,
    label: streamLabel("groups", phone),
    recover,
    processLive: (event) =>
      toGroupItem(client, event, phone, String(event.sequence)),
    processMissed: (event) =>
      event.type === "catchup.complete"
        ? Promise.resolve(toCatchUpCompleteItem(event))
        : toGroupItem(client, event, phone, String(event.sequence)),
    subscribeLive: (cursor) =>
      withClose(client.groups.subscribeEvents(), cursor),
  });

const clientStream = (
  client: AdvancedIMessage,
  pollCache: PollCache,
  phone: string,
  onInbound?: OnInboundMessage,
  recover?: () => Promise<void>
): ManagedStream<IMessageMessage> =>
  mergeStreams([
    messageStream(client, phone, onInbound, recover),
    pollStream(client, pollCache, phone, recover),
    groupStream(client, phone, recover),
  ]);

export const messages = (
  clients: RemoteClient[],
  projectConfig?: ProjectData | undefined
): ManagedStream<IMessageMessage> => {
  const pollCache = getPollCache(clients);
  // When the project profile opts in to iMessage sync, push the bot's contact
  // card to any chat we receive a new message in (24h dedupe per chat per line,
  // fire-and-forget). The tracker is keyed per `entry.client` — same shape as
  // `getMessageCache` — so each line dedupes independently (a DM guid encodes
  // the peer, not the line) and multi-Spectrum setups don't cross-pollute.
  const shareEnabled = projectConfig?.profile?.imessageSynced === true;
  // Cloud clients can re-mint a rejected token; explicit/static-token clients
  // return undefined (nothing to refresh). Shared across this client array's
  // streams so the message + poll loops coalesce onto one re-mint.
  const recover = getCloudRecover(clients);
  return mergeStreams(
    clients.map((entry) => {
      const tracker = shareEnabled
        ? getContactShareTracker(entry.client)
        : undefined;
      return clientStream(
        entry.client,
        pollCache,
        entry.phone,
        tracker ? (chatGuid) => tracker.maybeShare(chatGuid) : undefined,
        recover
      );
    })
  );
};
