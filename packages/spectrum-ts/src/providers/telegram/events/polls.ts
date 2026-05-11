import { asPollOption } from "../../../content/poll";
import type { PollAnswer, Update } from "../generated/types";
import { chatToSender, userToSender } from "../identity";
import type { CachedPoll, TelegramCache } from "../runtime/cache";
import type { TelegramMessage } from "../types";

// Telegram's `poll_answer` carries the post-vote vector (full current
// selection). Spectrum wants per-option `selected: true/false` diff
// events, so we keep each voter's prior vector and diff on every update.
// `poll_answer` is only delivered for non-anonymous polls the bot itself
// sent; `sendPoll` pins `is_anonymous: false` to enable this path.

const computeDiff = (
  prior: readonly number[],
  next: readonly number[]
): { added: number[]; removed: number[] } => {
  const priorSet = new Set(prior);
  const nextSet = new Set(next);
  const added = next.filter((id) => !priorSet.has(id));
  const removed = prior.filter((id) => !nextSet.has(id));
  return { added, removed };
};

const buildPollOptionEvent = (
  cached: CachedPoll,
  optionIndex: number,
  selected: boolean,
  context: {
    eventId: string;
    sender: ReturnType<typeof userToSender>;
    space: CachedPoll["chat"];
    timestamp: Date;
  }
): TelegramMessage | undefined => {
  const option = cached.poll.options[optionIndex];
  if (!option) {
    return undefined;
  }
  return {
    id: context.eventId,
    content: asPollOption({ poll: cached.poll, option, selected }),
    sender: context.sender,
    space: context.space,
    timestamp: context.timestamp,
  };
};

export const pollAnswerEvents = (
  answer: PollAnswer,
  cache: TelegramCache,
  update: Update
): TelegramMessage[] => {
  // Either `user` (regular voter) or `voter_chat` (anonymous channel
  // admin) is populated; chat ids are negative and disjoint from user
  // ids, so using them as the voter cache key avoids collisions.
  let sender: ReturnType<typeof userToSender>;
  let voterId: number;
  if (answer.user) {
    sender = userToSender(answer.user);
    voterId = answer.user.id;
  } else if (answer.voter_chat) {
    sender = chatToSender(answer.voter_chat);
    voterId = answer.voter_chat.id;
  } else {
    return [];
  }
  const cached = cache.polls.resolvePoll(answer.poll_id);
  if (!cached) {
    return [];
  }
  const prior = cache.polls.priorVote(answer.poll_id, voterId);
  const { added, removed } = computeDiff(prior, answer.option_ids);
  cache.polls.recordVote(answer.poll_id, voterId, answer.option_ids);

  // `poll_answer` carries no chat or timestamp; reuse the cached chat and
  // stamp with `now` (matches the iMessage poll-vote path).
  const space = cached.chat;
  const timestamp = new Date();

  const events: TelegramMessage[] = [];
  for (const optionIndex of added) {
    const event = buildPollOptionEvent(cached, optionIndex, true, {
      eventId: `poll_answer:${update.update_id}:add:${optionIndex}`,
      sender,
      space,
      timestamp,
    });
    if (event) {
      events.push(event);
    }
  }
  for (const optionIndex of removed) {
    const event = buildPollOptionEvent(cached, optionIndex, false, {
      eventId: `poll_answer:${update.update_id}:remove:${optionIndex}`,
      sender,
      space,
      timestamp,
    });
    if (event) {
      events.push(event);
    }
  }
  return events;
};
