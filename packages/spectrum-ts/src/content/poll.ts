import z from "zod";
import type { ContentBuilder } from "./types";

export const pollChoiceSchema = z.object({
  title: z.string().nonempty(),
});

export const pollSchema = z.object({
  type: z.literal("poll"),
  title: z.string().nonempty().max(300),
  options: z.array(pollChoiceSchema).min(2).max(10),
});

export const pollOptionSchema = z.object({
  type: z.literal("poll_option"),
  title: z.string().nonempty(),
  pollId: z.string().optional(),
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
  title: string;
  pollId?: string;
}): PollOption => pollOptionSchema.parse({ type: "poll_option", ...input });

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
