import z from "zod";
import type { ContentBuilder } from "./types";

export const customSchema = z.object({
  type: z.literal("custom"),
  raw: z.json(),
});

export function custom(
  raw: z.infer<ReturnType<typeof z.json>>
): ContentBuilder {
  return {
    build: () => Promise.resolve({ type: "custom", raw }),
  };
}
