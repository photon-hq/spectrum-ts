import z from "zod";
import type { Message, OutboundMessage } from "../types/message";
import { resolveContents } from "./resolve";
import type { BaseContent, ContentBuilder, ContentInput } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

// Same circularity dodge as reply.ts: predicate returns boolean rather than
// `v is Content` so the schema field is typed as BaseContent without
// referencing the outer Content union. Edit rejects nested
// edit/reply/reaction/group/typing in its builder so the looser static
// type is still correct at runtime.
const isContent = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  "type" in v &&
  typeof (v as { type: unknown }).type === "string";

/**
 * An `edit` rewrites the content of a previously-sent outbound message.
 *
 * `space.send(edit(newContent, message))` is the canonical outbound API;
 * `message.edit(newContent)` and `space.edit(message, newContent)` are
 * sugar that delegate here. Edits are fire-and-forget — providers handle
 * them inside their `send` action and the resolved value is `undefined`
 * (no new message id is produced; the existing message mutates in place).
 *
 * Edit cannot wrap `edit`, `reply`, `reaction`, `group`, or `typing`.
 */
export const editSchema = z.object({
  type: z.literal("edit"),
  content: z.custom<BaseContent>(isContent, {
    message: "edit content must be a Content value",
  }),
  target: z.custom<Message>(isMessage, {
    message: "edit target must be a Message",
  }),
});

export type Edit = z.infer<typeof editSchema>;

export const asEdit = (input: {
  content: BaseContent;
  target: Message;
}): Edit => editSchema.parse({ type: "edit", ...input });

/**
 * Construct an `edit` content value rewriting `target`'s content.
 *
 * `target` is typed as `OutboundMessage` because only messages you sent can
 * be edited; the schema field stays loose at `Message` (matching
 * reply/reaction) so providers receive the same shape regardless of
 * direction.
 */
export function edit(
  content: ContentInput,
  target: OutboundMessage
): ContentBuilder {
  return {
    build: async () => {
      const [resolved] = await resolveContents([content]);
      if (!resolved) {
        throw new Error("edit() requires content");
      }
      if (
        resolved.type === "edit" ||
        resolved.type === "reply" ||
        resolved.type === "reaction" ||
        resolved.type === "group" ||
        resolved.type === "typing"
      ) {
        throw new Error(`edit() cannot wrap "${resolved.type}" content`);
      }
      return asEdit({ content: resolved, target });
    },
  };
}
