import type {
  AdvancedIMessage,
  Poll as IMessagePoll,
  PollOption as IMessagePollOption,
  PollChangeDelta,
  PollEvent,
} from "@photon-ai/advanced-imessage";
import { asPoll, asPollOption, type PollChoice } from "../../../content/poll";
import type { CachedPoll, PollCache } from "../cache";
import type { IMessageMessage } from "../types";
import { chatTypeFromGuid } from "./ids";

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
      console.error("[spectrum-ts][imessage][poll] failed to cache poll", e);
    }
  }
};

const fetchPollInfo = async (
  client: AdvancedIMessage,
  cache: PollCache,
  event: PollEvent
): Promise<IMessagePoll | undefined> => {
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
  const cached = cache.get(event.pollMessageGuid);
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
  const eventTime = input.event.occurredAt.getTime();

  return {
    id: `${input.event.pollMessageGuid}:${input.senderAddress}:${input.optionId}:${action}:${eventTime}`,
    sender: { id: input.senderAddress },
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

const refreshPollMetadata = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent | UnvotedPollEvent
): Promise<CachedPoll | undefined> => {
  const info = await fetchPollInfo(client, pollCache, event);
  if (!info) {
    return;
  }
  return pollCache.get(info.pollMessageGuid);
};

const toPollOptionMessage = async (
  client: AdvancedIMessage,
  pollCache: PollCache,
  event: VotedPollEvent | UnvotedPollEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  const senderAddress = event.actor?.address;
  const optionId = event.delta.optionIdentifier;
  if (!(senderAddress && optionId)) {
    return [];
  }

  let cached = await resolvePoll(client, pollCache, event);
  if (!cached) {
    return [];
  }

  if (!cached.optionsByIdentifier.has(optionId)) {
    const refreshed = await refreshPollMetadata(client, pollCache, event);
    if (refreshed) {
      cached = refreshed;
    }
  }

  const message = buildPollOptionMessage({
    cached,
    chatGuid: event.chatGuid,
    event,
    optionId,
    phone,
    selected: event.delta.type === "voted",
    senderAddress,
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
