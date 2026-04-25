import type {
  AdvancedIMessage,
  PollInfo as IMessagePollInfo,
  PollOption as IMessagePollOption,
  PollChangeDelta,
  PollEvent,
} from "@photon-ai/advanced-imessage";
import { asPoll, asPollOption, type PollChoice } from "../../../content/poll";
import type { CachedPoll, PollCache, PollSelectionDelta } from "../cache";
import type { IMessageMessage } from "../types";

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
  event: Pick<PollEvent, "at" | "pollMessageGuid">;
  optionId: string;
  selected: boolean;
  senderAddress: string;
}

interface PollOptionMessagesInput {
  cached: CachedPoll;
  chatGuid: string;
  deltas: readonly PollSelectionDelta[];
  event: Pick<PollEvent, "at" | "pollMessageGuid">;
  senderAddress: string;
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

const cachePollInfo = (
  cache: PollCache,
  info: IMessagePollInfo
): CachedPoll => {
  const cached = toCachedPoll(info);
  cache.set(info.messageGuid as string, cached);
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
      cache.set(event.pollMessageGuid as string, cached);
      return cached;
    } catch (e) {
      console.error("[spectrum-ts][imessage][poll] failed to cache poll", e);
    }
  }
};

const fetchPollInfo = async (
  client: AdvancedIMessage,
  cache: PollCache,
  event: PollEvent
): Promise<IMessagePollInfo | undefined> => {
  try {
    const info = await client.polls.get(event.pollMessageGuid);
    cachePollInfo(cache, info);
    return info;
  } catch (e) {
    console.error("[spectrum-ts][imessage][poll] failed to fetch poll", e);
    return;
  }
};

const resolvePoll = async (
  client: AdvancedIMessage,
  cache: PollCache,
  event: PollEvent
): Promise<CachedPoll | undefined> => {
  const pollId = event.pollMessageGuid as string;
  const cached = cache.get(pollId);
  if (cached) {
    return cached;
  }
  try {
    const info = await client.polls.get(event.pollMessageGuid);
    return cachePollInfo(cache, info);
  } catch (e) {
    console.error("[spectrum-ts][imessage][poll] failed to resolve poll", e);
    return;
  }
};

const buildPollOptionMessage = (
  input: PollOptionMessageInput
): IMessageMessage | undefined => {
  const option = input.cached.optionsByIdentifier.get(input.optionId);
  if (!option) {
    return;
  }
  const action = input.selected ? "selected" : "deselected";
  return {
    id: `${input.event.pollMessageGuid}:${input.senderAddress}:${input.optionId}:${action}:${input.event.at.getTime()}`,
    sender: { id: input.senderAddress },
    space: {
      id: input.chatGuid,
      type: input.chatGuid.includes(";+;") ? "group" : "dm",
    },
    timestamp: input.event.at,
    content: asPollOption({
      option,
      poll: input.cached.poll,
      selected: input.selected,
    }),
  };
};

const buildPollOptionMessages = (
  input: PollOptionMessagesInput
): IMessageMessage[] => {
  const messages: IMessageMessage[] = [];
  for (const delta of input.deltas) {
    const message = buildPollOptionMessage({
      cached: input.cached,
      chatGuid: input.chatGuid,
      event: input.event,
      optionId: delta.optionId,
      selected: delta.selected,
      senderAddress: input.senderAddress,
    });
    if (message) {
      messages.push(message);
    }
  }
  return messages;
};

const allOptionIdsKnown = (
  cached: CachedPoll,
  optionIds: readonly string[]
): boolean =>
  optionIds.every((optionId) => cached.optionsByIdentifier.has(optionId));

const refreshPollMetadata = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent,
  fallbackOptionIds: readonly string[]
): Promise<{ optionIds: string[]; poll: CachedPoll } | undefined> => {
  const info = await fetchPollInfo(client, pollCache, event);
  if (!info) {
    return;
  }
  const refreshed = pollCache.get(info.messageGuid as string);
  if (!refreshed) {
    return;
  }
  return {
    optionIds: [...fallbackOptionIds],
    poll: refreshed,
  };
};

const toPollVoteMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent
): Promise<IMessageMessage[]> => {
  const senderAddress = event.actor.address;
  if (!senderAddress) {
    return [];
  }
  const pollId = event.pollMessageGuid as string;
  if (pollCache.isStaleActorSelectionEvent(pollId, senderAddress, event.at)) {
    return [];
  }
  const cached = await resolvePoll(client, pollCache, event);
  if (!cached) {
    return [];
  }
  const chatGuidStr = event.chatGuid as string;
  let currentOptionIds = [...event.delta.optionIdentifiers];
  let resolvedPoll = cached;

  if (
    currentOptionIds.some(
      (optionId) => !resolvedPoll.optionsByIdentifier.has(optionId)
    )
  ) {
    const snapshot = await refreshPollMetadata(
      client,
      pollCache,
      event,
      currentOptionIds
    );
    if (snapshot) {
      currentOptionIds = snapshot.optionIds;
      resolvedPoll = snapshot.poll;
    }
  }

  if (!allOptionIdsKnown(resolvedPoll, currentOptionIds)) {
    return [];
  }

  const deltas = pollCache.actorSelectionDeltas(
    pollId,
    senderAddress,
    currentOptionIds
  );
  const messages = buildPollOptionMessages({
    cached: resolvedPoll,
    chatGuid: chatGuidStr,
    deltas,
    event,
    senderAddress,
  });

  pollCache.commitActorSelection(
    pollId,
    senderAddress,
    currentOptionIds,
    event.at
  );

  return messages;
};

const toPollUnvoteMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: UnvotedPollEvent
): Promise<IMessageMessage[]> => {
  const senderAddress = event.actor.address;
  if (!senderAddress) {
    return [];
  }
  const pollId = event.pollMessageGuid as string;
  if (pollCache.isStaleActorSelectionEvent(pollId, senderAddress, event.at)) {
    return [];
  }
  const cached = await resolvePoll(client, pollCache, event);
  if (!cached) {
    return [];
  }
  const chatGuidStr = event.chatGuid as string;
  const deltas = pollCache.clearedActorSelectionDeltas(pollId, senderAddress);
  const messages = buildPollOptionMessages({
    cached,
    chatGuid: chatGuidStr,
    deltas,
    event,
    senderAddress,
  });
  pollCache.commitActorSelection(pollId, senderAddress, [], event.at);
  return messages;
};

export const toPollDeltaMessages = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: PollEvent
): Promise<IMessageMessage[]> => {
  if (isVotedPollEvent(event)) {
    return toPollVoteMessages(client, pollCache, event);
  }
  if (isUnvotedPollEvent(event)) {
    return toPollUnvoteMessages(client, pollCache, event);
  }
  return [];
};
