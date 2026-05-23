import z from "zod";
import type { ContentBuilder } from "./types";

/**
 * Rename the current chat. Universal content — providers dispatch by
 * `content.type === "rename"` in their `send` action and decide their own
 * support story (e.g. iMessage only supports it for remote group chats).
 *
 * `space.send(rename("New Name"))` is the canonical form; `space.rename(...)`
 * is universal sugar that delegates here.
 *
 * Throws at build time if `displayName` is empty. Per-platform constraints
 * (e.g. group-only, remote-only) surface as `UnsupportedError` from the
 * provider's `send` action so the canonical and sugar forms share one
 * error path.
 */
export const renameSchema = z.object({
  type: z.literal("rename"),
  displayName: z.string().min(1, "rename() displayName must be non-empty"),
});

export type Rename = z.infer<typeof renameSchema>;

export function rename(displayName: string): ContentBuilder {
  return {
    build: async () => renameSchema.parse({ type: "rename", displayName }),
  };
}
