import z from "zod";
import { attachmentSchema } from "./attachment";
import { contactSchema } from "./contact";
import { customSchema } from "./custom";
import { editSchema } from "./edit";
import { messageEffectSchema } from "./effect";
import { groupSchema } from "./group";
import { pollOptionSchema, pollSchema } from "./poll";
import { reactionSchema } from "./reaction";
import { replySchema } from "./reply";
import { richlinkSchema } from "./richlink";
import { textSchema } from "./text";
import { typingSchema } from "./typing";
import { voiceSchema } from "./voice";

// `baseContentSchema` is everything except `reply` and `edit`. It exists so
// the inner content of a `Reply` (and `Edit`) can be typed against this
// non-circular union without `Content` referencing itself via
// `Reply.content` / `Edit.content`. Both builders reject nested wrapping
// in their reject-lists, so the looser typing here is also correct.
const baseContentSchemas = [
  textSchema,
  customSchema,
  attachmentSchema,
  contactSchema,
  voiceSchema,
  richlinkSchema,
  reactionSchema,
  groupSchema,
  pollSchema,
  pollOptionSchema,
  messageEffectSchema,
  typingSchema,
] as const;

export const baseContentSchema = z.discriminatedUnion(
  "type",
  baseContentSchemas
);

export type BaseContent = z.infer<typeof baseContentSchema>;

export const contentSchema = z.discriminatedUnion("type", [
  ...baseContentSchemas,
  replySchema,
  editSchema,
]);

export type Content = z.infer<typeof contentSchema>;

export interface ContentBuilder {
  build(): Promise<Content>;
}

export type ContentInput = string | ContentBuilder;
