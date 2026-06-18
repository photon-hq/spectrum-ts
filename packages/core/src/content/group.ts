import z from "zod";
import type { Message } from "../types/message";
import { resolveContents } from "./resolve";
import type { Content, ContentBuilder, ContentInput } from "./types";

const isMessage = (v: unknown): v is Message =>
  typeof v === "object" && v !== null && "id" in v && "content" in v;

/**
 * A `group` bundles multiple messages into one logical unit (e.g. an album
 * of images sent together). Each item is a full `Message` — addressable by
 * id, reactable via `.react()`, replyable via `.reply()`.
 *
 * Groups do not nest, and reactions cannot be group members. Enforced by the
 * `group()` builder; platforms may additionally reject unsupported item
 * content types at send time.
 */
export const groupSchema = z.object({
  type: z.literal("group"),
  items: z.array(z.custom<Message>(isMessage)).min(2),
});

export type Group = z.infer<typeof groupSchema>;

export const asGroup = (input: { items: Message[] }): Group =>
  groupSchema.parse({ type: "group", items: input.items });

// For outbound groups built via `group(attachment(...), ...)` the group items
// are not real Messages yet — they have no id, space, or methods until the
// provider's send path dispatches each one natively. We wrap the resolved
// content in a minimal shape that satisfies the `isMessage` guard and the
// providers read `item.content` directly.
const stubOutboundMessage = (content: Content): Message =>
  ({ id: "", content }) as unknown as Message;

export function group(
  ...items: [ContentInput, ContentInput, ...ContentInput[]]
): ContentBuilder {
  return {
    build: async () => {
      const resolved = await resolveContents(items);
      const members: Message[] = [];
      for (const item of resolved) {
        if (item.type === "group" || item.type === "reaction") {
          throw new Error(`group() cannot contain "${item.type}" items`);
        }
        members.push(stubOutboundMessage(item));
      }
      return asGroup({ items: members });
    },
  };
}
