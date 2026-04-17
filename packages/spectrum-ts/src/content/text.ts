import z from "zod";
import type { ContentBuilder } from "./types";

export const textSchema = z.object({
  type: z.literal("text"),
  text: z.string().nonempty(),
});

export function text(text: string): ContentBuilder {
  return {
    build: () => Promise.resolve({ type: "text", text }),
  };
}
