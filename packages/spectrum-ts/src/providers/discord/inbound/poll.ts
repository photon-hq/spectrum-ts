import { asPoll, type Poll, type PollChoice } from "../../../content/poll";

// A poll as exposed by either a gateway message's `poll` field or a REST
// `PollResponse`. Both surface `question.text` and `answers[].poll_media.text`
// plus a stable per-answer `answer_id`, so one shape covers both paths.
interface PollMediaLike {
  text?: string | null;
}
interface PollAnswerLike {
  answer_id: number;
  poll_media: PollMediaLike;
}
interface PollLike {
  answers: PollAnswerLike[];
  question: PollMediaLike;
}

export interface ReconstructedPoll {
  /** `answerIds[i]` is the Discord `answer_id` for `poll.options[i]`. */
  answerIds: number[];
  poll: Poll;
}

// Spectrum's poll schema requires at least two options; a poll with fewer is
// dropped rather than surfaced.
const MIN_OPTIONS = 2;

/**
 * Reconstruct a Spectrum poll from a Discord poll object. Returns `undefined`
 * when the question is empty or fewer than two answers carry text (the schema
 * requires `min(2)`), so malformed or partial polls are skipped rather than
 * throwing. Each kept option's `answer_id` is tracked alongside it so poll-vote
 * dispatches — which reference only an `answer_id` — can resolve their choice.
 */
export const reconstructPoll = (
  poll: PollLike
): ReconstructedPoll | undefined => {
  const title = poll.question.text?.trim();
  if (!title) {
    return;
  }
  const answerIds: number[] = [];
  const options: PollChoice[] = [];
  for (const answer of poll.answers) {
    const optionTitle = answer.poll_media.text?.trim();
    if (!optionTitle) {
      continue;
    }
    answerIds.push(answer.answer_id);
    options.push({ title: optionTitle });
  }
  if (options.length < MIN_OPTIONS) {
    return;
  }
  return { answerIds, poll: asPoll({ options, title }) };
};

/** Resolve the option a poll-vote `answer_id` refers to, if any. */
export const optionForAnswerId = (
  reconstructed: ReconstructedPoll,
  answerId: number
): PollChoice | undefined => {
  const index = reconstructed.answerIds.indexOf(answerId);
  return index === -1 ? undefined : reconstructed.poll.options[index];
};
