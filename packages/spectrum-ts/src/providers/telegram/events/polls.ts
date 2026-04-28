import { asPollOption } from "../../../content/poll";
import type { PollAnswer, Update } from "../generated/types";
import { chatToSender, userToSender } from "../identity";
import type { CachedPoll, TelegramCache } from "../runtime/cache";
import type { TelegramMessage } from "../types";

// ---------------------------------------------------------------------------
// poll_answer → poll_option events
//
// Telegram's `Update.poll_answer` carries the *post-vote vector* (`option_ids`
// is the user's complete current selection) along with `poll_id` and `user`.
// Spectrum's `poll_option` content type expects per-option diff events with
// `selected: true` (vote added) or `selected: false` (vote removed) — see
// PR #35 and the iMessage remote provider for the canonical contract.
//
// We bridge the two by storing each user's prior selection vector and
// computing the diff on every `poll_answer`. The poll itself (full Spectrum
// `Poll` value plus original chat/message ids) is cached when the bot sends
// the poll via `messages.ts:sendPollContent`. Polls sent by other clients
// in a chat are not cached and produce no events: Telegram only delivers
// `poll_answer` for polls a bot owns AND that have `is_anonymous: false`,
// and our `sendPoll` always pins that flag, so this gating is automatic.
//
// Anonymous channel votes (`voter_chat`, no `user`) are surfaced via
// `chatToSender`, mirroring how anonymous channel-admin reactions and
// channel posts are handled. The chat's id (negative integer) is stable per
// channel and disjoint from user ids (positive), so per-voter vote-vector
// state stays correctly partitioned.
// ---------------------------------------------------------------------------

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
    // Telegram returned an option index that doesn't exist in the cached
    // poll — should be unreachable for a poll we sent ourselves, but we
    // skip rather than throw so a single bad event can't break the stream.
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
  // Telegram populates either `user` (regular voter) or `voter_chat` (an
  // anonymous channel admin). Bail only when neither is present — that's a
  // malformed update.
  let sender: ReturnType<typeof userToSender>;
  let voterId: number;
  if (answer.user) {
    sender = userToSender(answer.user);
    voterId = answer.user.id;
  } else if (answer.voter_chat) {
    sender = chatToSender(answer.voter_chat);
    // Chat ids are negative in Telegram and disjoint from user ids, so
    // using `chat.id` as the per-voter cache key avoids collisions with
    // any real user voting on the same poll.
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
  // Persist the new vector so the next `poll_answer` for this voter diffs
  // against the most recent state, not the original empty vector.
  cache.polls.recordVote(answer.poll_id, voterId, answer.option_ids);

  // Telegram doesn't surface chat or timestamp on `poll_answer`. We reuse
  // the chat snapshot captured when the poll was sent and stamp the event
  // with `now`. Same approach iMessage uses (its poll vote events fall
  // back to "now" when the SDK doesn't surface a server timestamp).
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
