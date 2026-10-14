import type {
  AdvancedIMessage,
  Poll as IMessagePoll,
  PollOption as IMessagePollOption,
  PollChangeDelta,
  PollEvent,
} from "@photon-ai/advanced-imessage/grpc";
import type { PollChoice } from "@spectrum-ts/core";
import {
  asPoll,
  asPollOption,
  createLogger,
  errorAttrs,
} from "@spectrum-ts/core/authoring";
import type { CachedPoll, PollCache } from "../cache";
import type { IMessageMessage } from "../types";
import { chatTypeFromGuid } from "./ids";
import { toSenderRef } from "./inbound";
import { lookupRelated } from "./related-lookup";

const log = createLogger("spectrum.imessage.poll");

type VotedPollEvent = PollEvent & {
  delta: Extract<PollChangeDelta, { type: "voted" }>;
};

type UnvotedPollEvent = PollEvent & {
  delta: Extract<PollChangeDelta, { type: "unvoted" }>;
};

interface PollMetadataInput {
  options: readonly IMessagePollOption[];
  title: string;
}

interface PollOptionMessageInput {
  cached: CachedPoll;
  chatGuid: string;
  event: Pick<PollEvent, "occurredAt" | "pollMessageGuid">;
  optionId: string;
  phone: string;
  selected: boolean;
  sender: ReturnType<typeof toSenderRef>;
}

const isVotedPollEvent = (event: PollEvent): event is VotedPollEvent =>
  event.delta.type === "voted";

const isUnvotedPollEvent = (event: PollEvent): event is UnvotedPollEvent =>
  event.delta.type === "unvoted";

const toCachedPoll = (input: PollMetadataInput): CachedPoll => {
  const poll = asPoll({
    title: input.title,
    options: input.options.map((optionInfo) => ({
      title: optionInfo.text,
    })),
  });
  const optionsByIdentifier = new Map<string, PollChoice>();
  for (const [index, optionInfo] of input.options.entries()) {
    const option = poll.options[index];
    if (option && optionInfo.optionIdentifier) {
      optionsByIdentifier.set(optionInfo.optionIdentifier, option);
    }
  }
  return { poll, optionsByIdentifier };
};

const cachePollInfo = (cache: PollCache, info: IMessagePoll): CachedPoll => {
  const cached = toCachedPoll(info);
  cache.set(info.pollMessageGuid, cached);
  return cached;
};

export const cachePollEvent = (
  cache: PollCache,
  event: PollEvent
): CachedPoll | undefined => {
  if (event.delta.type === "created" || event.delta.type === "optionAdded") {
    try {
      const cached = toCachedPoll({
        title: event.delta.title,
        options: event.delta.options,
      });
      cache.set(event.pollMessageGuid, cached);
      return cached;
    } catch (e) {
      log.error(
        "failed to cache poll",
        {
          "spectrum.imessage.poll.guid": event.pollMessageGuid,
          ...errorAttrs(e),
        },
        e
      );
    }
  }
};

/**
 * Poll title/options for a vote event, always from a fresh `polls.get`. The
 * poll cache (warmed by `created`/`optionAdded` events and by this lookup) is
 * write-only on this path: metadata cached while the poll was visible must
 * not be emitted after it is hidden, reassigned, or edited.
 *
 * The fresh read is authoritative for option matching, so there is no second
 * "refresh on unknown option" fetch. Hidden/not-found/permission-denied
 * resolves `undefined` (the vote is dropped and the cursor advances); any
 * other failure rejects retryably so the stream redelivers the vote.
 */
const resolvePoll = async (
  client: AdvancedIMessage,
  cache: PollCache,
  event: PollEvent
): Promise<CachedPoll | undefined> => {
  const info = await lookupRelated("poll", event.pollMessageGuid, () =>
    client.polls.get(event.pollMessageGuid)
  );
  if (!info) {
    return;
  }
  return cachePollInfo(cache, info);
};

const buildPollOptionMessage = (
  input: PollOptionMessageInput
): IMessageMessage | undefined => {
  const option = input.cached.optionsByIdentifier.get(input.optionId);
  if (!option) {
    return;
  }
  const action = input.selected ? "selected" : "deselected";
  const eventTime = input.event.occurredAt.getTime();

  return {
    id: `${input.event.pollMessageGuid}:${input.sender.id}:${input.optionId}:${action}:${eventTime}`,
    sender: input.sender,
    space: {
      id: input.chatGuid,
      type: chatTypeFromGuid(input.chatGuid),
      phone: input.phone,
    },
    timestamp: input.event.occurredAt,
    content: asPollOption({
      option,
      poll: input.cached.poll,
      selected: input.selected,
    }),
  };
};

const toPollOptionMessage = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent | UnvotedPollEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  const sender = toSenderRef(event.actor);
  const optionId = event.delta.optionIdentifier;
  if (!(sender.id && optionId)) {
    return [];
  }

  const cached = await resolvePoll(client, pollCache, event);
  if (!cached) {
    return [];
  }

  // An option absent from the fresh poll is dropped by buildPollOptionMessage.
  const message = buildPollOptionMessage({
    cached,
    chatGuid: event.chatGuid,
    event,
    optionId,
    phone,
    selected: event.delta.type === "voted",
    sender,
  });

  return message ? [message] : [];
};

export const toPollDeltaMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: PollEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  if (isVotedPollEvent(event)) {
    return toPollOptionMessage(client, pollCache, event, phone);
  }
  if (isUnvotedPollEvent(event)) {
    return toPollOptionMessage(client, pollCache, event, phone);
  }
  return [];
};
