import z from "zod";
import type { ContentBuilder } from "./types";

export const pollChoiceSchema = z.object({
  title: z.string().nonempty(),
  optionIdentifier: z.string().nonempty().optional(),
});

export const pollSchema = z
  .object({
    type: z.literal("poll"),
    title: z.string().max(300).optional(),
    options: z.array(pollChoiceSchema).min(2).max(10),
    pollMessageGuid: z.string().nonempty().optional(),
    // Option additions carry the full current option set, not a vote.
    change: z.enum(["created", "optionAdded"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.pollMessageGuid) {
      if (!value.title) {
        ctx.addIssue({
          code: "custom",
          message: "poll title must not be empty",
          path: ["title"],
        });
      }
      if (value.change) {
        ctx.addIssue({
          code: "custom",
          message: "poll change requires pollMessageGuid",
          path: ["pollMessageGuid"],
        });
      }
      return;
    }
    const identifiers = new Set<string>();
    for (const [index, choice] of value.options.entries()) {
      if (
        !choice.optionIdentifier ||
        identifiers.has(choice.optionIdentifier)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "native poll options require unique optionIdentifier values",
          path: ["options", index, "optionIdentifier"],
        });
      } else {
        identifiers.add(choice.optionIdentifier);
      }
    }
  });

export const pollOptionSchema = z
  .object({
    type: z.literal("poll_option"),
    option: pollChoiceSchema,
    poll: pollSchema,
    selected: z.boolean(),
    title: z.string().nonempty(),
    pollMessageGuid: z.string().nonempty().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.title !== value.option.title) {
      ctx.addIssue({
        code: "custom",
        message: "poll_option title must match option.title",
        path: ["title"],
      });
    }
    if (value.pollMessageGuid !== value.poll.pollMessageGuid) {
      ctx.addIssue({
        code: "custom",
        message: "poll_option pollMessageGuid must match poll.pollMessageGuid",
        path: ["pollMessageGuid"],
      });
    }
    const usesIdentifiers = Boolean(
      value.poll.pollMessageGuid || value.option.optionIdentifier
    );
    if (
      !value.poll.options.some((pollOption) =>
        usesIdentifiers
          ? Boolean(value.option.optionIdentifier) &&
            pollOption.optionIdentifier === value.option.optionIdentifier &&
            pollOption.title === value.option.title
          : pollOption.title === value.option.title
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
  /** A definition snapshot, not an option selection. */
  change?: "created" | "optionAdded";
  options: PollChoice[];
  /** Native poll identity; required for titleless iMessage snapshots. */
  pollMessageGuid?: string;
  title?: string;
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
    ...(input.poll.pollMessageGuid
      ? { pollMessageGuid: input.poll.pollMessageGuid }
      : {}),
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
