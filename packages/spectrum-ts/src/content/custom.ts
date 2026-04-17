import z from "zod";
import type { ContentBuilder } from "./types";

export const customSchema = z.object({
  type: z.literal("custom"),
  raw: z.unknown(),
});

export function custom(raw: unknown): ContentBuilder {
  return {
    build: () => Promise.resolve({ type: "custom", raw }),
  };
}
