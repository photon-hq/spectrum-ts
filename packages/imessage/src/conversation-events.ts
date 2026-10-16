import type { Content } from "@spectrum-ts/core";
import type { IMessageConversationEvent } from "./types";

export const isConversationEventItemType = (
  itemType: unknown
): itemType is IMessageConversationEvent["itemType"] =>
  itemType === "chatAction" ||
  itemType === "groupNameChange" ||
  itemType === "participantChange";

/** Identifies content-less conversation updates, including reply-wrapped updates.
 * Reply targets are deliberately ignored: replying to an update is a message.
 */
export const isIMessageConversationEvent = (message: {
  content: Content;
}): boolean => {
  const content =
    message.content.type === "reply"
      ? message.content.content
      : message.content;
  if (content.type !== "custom") {
    return false;
  }
  const { raw } = content;
  return (
    typeof raw === "object" &&
    raw !== null &&
    "imessage_type" in raw &&
    raw.imessage_type === "conversation-event" &&
    "itemType" in raw &&
    isConversationEventItemType(raw.itemType)
  );
};
