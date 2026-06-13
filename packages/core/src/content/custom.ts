import z from "zod";
import type { ContentBuilder } from "./types";

export const customSchema = z.object({
  type: z.literal("custom"),
  raw: z.unknown(),
});

export const asCustom = (raw: unknown): z.infer<typeof customSchema> =>
  customSchema.parse({ type: "custom", raw });

export function custom(raw: unknown): ContentBuilder {
  return {
    build: async () => asCustom(raw),
  };
}
