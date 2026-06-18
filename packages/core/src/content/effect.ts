import z from "zod";
import { attachmentSchema } from "./attachment";
import { markdownSchema } from "./markdown";
import { textSchema } from "./text";

const effectInnerSchema = z.discriminatedUnion("type", [
  textSchema,
  markdownSchema,
  attachmentSchema,
]);

export const messageEffectSchema = z.object({
  type: z.literal("effect"),
  content: effectInnerSchema,
  effect: z.string().nonempty(),
});

export type MessageEffect = z.infer<typeof messageEffectSchema>;
export type MessageEffectInner = z.infer<typeof effectInnerSchema>;
