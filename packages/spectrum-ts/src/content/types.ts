import z from "zod";
import { attachmentSchema } from "./attachment";
import { customSchema } from "./custom";
import { textSchema } from "./text";

export const contentSchema = z.discriminatedUnion("type", [
  textSchema,
  customSchema,
  attachmentSchema,
]);

export type Content = z.infer<typeof contentSchema>;

export interface ContentBuilder {
  build(): Promise<Content>;
}

export type ContentInput = string | ContentBuilder;
