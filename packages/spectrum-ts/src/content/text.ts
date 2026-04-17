import z from "zod";
import type { ContentBuilder } from "./types";

export const textSchema = z.object({
  type: z.literal("text"),
  text: z.string().nonempty(),
});

export const asText = (text: string): z.infer<typeof textSchema> =>
  textSchema.parse({ type: "text", text });

export function text(text: string): ContentBuilder {
  return {
    build: async () => asText(text),
  };
}
