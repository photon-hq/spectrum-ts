import z from "zod";
import type { Message } from "../types/message";
import { resolveContents } from "./resolve";
import type { BaseContent, ContentBuilder, ContentInput } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

// Predicate returns `boolean` rather than `v is Content` so its signature
// does not reference `Content` directly. The schema below types its inner
// `content` field as `BaseContent` (the union of every content type *except*
// reply) so `Reply ↔ Content` is not a circular type alias. Reply rejects
// nested `reply`/`reaction`/`group` content in its builder anyway, so this
// looser static type is still correct at runtime.
const isContent = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  "type" in v &&
  typeof (v as { type: unknown }).type === "string";

/**
 * A `reply` wraps inner content with the message it replies to.
 *
 * `space.send(reply(content, message))` is the canonical outbound API;
 * `message.reply(content)` is sugar that delegates here. Providers see
 * `reply` like any other content type and route to a threaded send.
 *
 * Reply cannot wrap `reply`, `edit`, `reaction`, `group`, `typing`,
 * `rename`, `avatar`, `addMember`, `removeMember`, `leaveSpace`, `unsend`,
 * or `read` content.
 */
export const replySchema = z.object({
  type: z.literal("reply"),
  content: z.custom<BaseContent>(isContent, {
    message: "reply content must be a Content value",
  }),
  target: z.custom<Message>(isMessage, {
    message: "reply target must be a Message",
  }),
});

export type Reply = z.infer<typeof replySchema>;

export const asReply = (input: {
  content: BaseContent;
  target: Message;
}): Reply => replySchema.parse({ type: "reply", ...input });

export function reply(
  content: ContentInput,
  target: Message | undefined
): ContentBuilder {
  return {
    build: async () => {
      if (!target) {
        throw new Error(
          "reply() target is undefined — the targeted message was never sent (space.send resolves undefined when a platform skips unsupported content)"
        );
      }
      const [resolved] = await resolveContents([content]);
      if (!resolved) {
        throw new Error("reply() requires content");
      }
      if (
        resolved.type === "reply" ||
        resolved.type === "edit" ||
        resolved.type === "reaction" ||
        resolved.type === "group" ||
        resolved.type === "typing" ||
        resolved.type === "rename" ||
        resolved.type === "avatar" ||
        resolved.type === "addMember" ||
        resolved.type === "removeMember" ||
        resolved.type === "leaveSpace" ||
        resolved.type === "unsend" ||
        resolved.type === "read"
      ) {
        throw new Error(`reply() cannot wrap "${resolved.type}" content`);
      }
      return asReply({ content: resolved, target });
    },
  };
}
