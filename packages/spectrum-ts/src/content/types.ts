import z from "zod";
import { attachmentSchema } from "./attachment";
import { contactSchema } from "./contact";
import { customSchema } from "./custom";
import { messageEffectSchema } from "./effect";
import { groupSchema } from "./group";
import { pollOptionSchema, pollSchema } from "./poll";
import { reactionSchema } from "./reaction";
import { richlinkSchema } from "./richlink";
import { textSchema } from "./text";
import { voiceSchema } from "./voice";

export const contentSchema = z.discriminatedUnion("type", [
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
]);

export type Content = z.infer<typeof contentSchema>;

export interface ContentBuilder {
  build(): Promise<Content>;
}

export type ContentInput = string | ContentBuilder;
