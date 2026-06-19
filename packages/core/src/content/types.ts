import z from "zod";
import { appSchema } from "./app";
import { attachmentSchema } from "./attachment";
import { avatarSchema } from "./avatar";
import { contactSchema } from "./contact";
import { customSchema } from "./custom";
import { editSchema } from "./edit";
import { messageEffectSchema } from "./effect";
import { groupSchema } from "./group";
import { markdownSchema } from "./markdown";
import { pollOptionSchema, pollSchema } from "./poll";
import { reactionSchema } from "./reaction";
import { readSchema } from "./read";
import { renameSchema } from "./rename";
import { replySchema } from "./reply";
import { richlinkSchema } from "./richlink";
import { streamTextSchema } from "./stream-text";
import { textSchema } from "./text";
import { typingSchema } from "./typing";
import { unsendSchema } from "./unsend";
import { voiceSchema } from "./voice";

// `baseContentSchema` is everything except `reply`, `edit`, `unsend`, and
// `read`. It exists so the inner content of a `Reply` (and `Edit`) can be
// typed against this non-circular union without `Content` referencing itself
// via `Reply.content` / `Edit.content`. Both builders reject nested wrapping
// in their reject-lists, so the looser typing here is also correct.
// `unsend` and `read` carry no inner content but stay out of the base union
// too, so reply/edit cannot statically wrap them.
const baseContentSchemas = [
  textSchema,
  markdownSchema,
  streamTextSchema,
  customSchema,
  attachmentSchema,
  contactSchema,
  voiceSchema,
  richlinkSchema,
  appSchema,
  reactionSchema,
  groupSchema,
  pollSchema,
  pollOptionSchema,
  messageEffectSchema,
  typingSchema,
  renameSchema,
  avatarSchema,
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
  unsendSchema,
  readSchema,
]);

export type Content = z.infer<typeof contentSchema>;

export interface ContentBuilder {
  build(): Promise<Content>;
}

export type ContentInput = string | ContentBuilder;
