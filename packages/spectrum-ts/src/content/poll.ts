import z from "zod";
import type { ContentBuilder } from "./types";

// Lenient on the wire: iMessage's PollOption.text is a proto3 string, which
// defaults to "" and carries no non-empty guarantee from the source. Strict
// parsing here would silently drop entire polls if any option arrived with
// empty text. If outbound construction needs to require non-empty options,
// gate that at the customer-facing builder rather than this inbound parser.
export const pollChoiceSchema = z.object({
  title: z.string(),
});

// Lenient on the wire: iMessage can deliver polls with empty or missing
// titles (untitled polls, or partial deltas for `optionAdded` events that
// don't always re-carry the title in practice). Strict `.nonempty()` parsing
// dropped real customer polls silently — see
// https://github.com/photon-hq/spectrum-ts (fix/poll-schema-allow-empty-title).
// If outbound construction needs to require a title, gate that at the
// customer-facing builder rather than this inbound parser.
export const pollSchema = z.object({
  type: z.literal("poll"),
  title: z.string().max(300).optional(),
  options: z.array(pollChoiceSchema).min(2).max(10),
});

export const pollOptionSchema = z
  .object({
    type: z.literal("poll_option"),
    option: pollChoiceSchema,
    poll: pollSchema,
    selected: z.boolean(),
    // Mirrors pollChoiceSchema.title — the superRefine below still enforces
    // structural equality with option.title, so empty strings round-trip
    // correctly without silently dropping the vote.
    title: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.title !== value.option.title) {
      ctx.addIssue({
        code: "custom",
        message: "poll_option title must match option.title",
        path: ["title"],
      });
    }
    if (
      !value.poll.options.some(
        (pollOption) => pollOption.title === value.option.title
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "poll_option option must exist in poll.options",
        path: ["option"],
      });
    }
  });

export type Poll = z.infer<typeof pollSchema>;
export type PollChoice = z.infer<typeof pollChoiceSchema>;
export type PollOption = z.infer<typeof pollOptionSchema>;

export type PollChoiceInput = string | { title: string };

export interface PollInput {
  options: PollChoice[];
  title: string;
}

export const asPoll = (input: PollInput): Poll =>
  pollSchema.parse({ type: "poll", ...input });

export const asPollOption = (input: {
  option: PollChoice;
  poll: Poll;
  selected: boolean;
}): PollOption =>
  pollOptionSchema.parse({
    type: "poll_option",
    ...input,
    title: input.option.title,
  });

export const option = (title: string): PollChoice => ({ title });

const normalize = (raw: PollChoiceInput): PollChoice =>
  typeof raw === "string" ? { title: raw } : { title: raw.title };

const collectOptions = (
  args: readonly [PollChoiceInput[]] | readonly PollChoiceInput[]
): PollChoiceInput[] => {
  const [first] = args;
  if (args.length === 1 && Array.isArray(first)) {
    return first;
  }
  return args as PollChoiceInput[];
};

export function poll(title: string, options: PollChoiceInput[]): ContentBuilder;
export function poll(
  title: string,
  ...options: PollChoiceInput[]
): ContentBuilder;
export function poll(
  title: string,
  ...rest: readonly [PollChoiceInput[]] | readonly PollChoiceInput[]
): ContentBuilder {
  return {
    build: async () =>
      asPoll({ title, options: collectOptions(rest).map(normalize) }),
  };
}
