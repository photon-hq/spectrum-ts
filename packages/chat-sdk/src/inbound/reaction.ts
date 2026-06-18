// Reaction conversion: turn a chat-SDK reaction event (add or remove) into a
// reaction record, stubbing the target message for core to wrap.

import { asCustom, reactionSchema } from "@spectrum-ts/core/authoring";
import type {
  ChatAdapter,
  ChatInboundMessage,
  ChatReactionEvent,
} from "../types";
import { spaceRef } from "./space";

// The SDK gives only the target's id; core wraps this stub into a full Message
// before the agent sees it (same approach as terminal).
const reactionTargetStub = (
  event: ChatReactionEvent,
  space: ReturnType<typeof spaceRef>
) => ({
  id: event.messageId,
  content: asCustom({ chatsdk_type: "reaction-target", stub: true }),
  sender: { id: "__unknown__" },
  space,
  timestamp: new Date(),
});

export const reactionToRecord = (
  adapter: ChatAdapter,
  event: ChatReactionEvent
): ChatInboundMessage => {
  const space = spaceRef(adapter, event.threadId);
  // Add and remove of the same emoji are distinct events — keep their ids
  // distinct so neither dedupes the other.
  const id = event.added
    ? `reaction:${event.messageId}:${event.rawEmoji}`
    : `reaction:removed:${event.messageId}:${event.rawEmoji}`;
  return {
    id,
    content: reactionSchema.parse({
      type: "reaction",
      emoji: event.rawEmoji,
      action: event.added ? "add" : "remove",
      target: reactionTargetStub(event, space),
    }),
    sender: { id: event.user.userId },
    space,
    timestamp: new Date(),
  };
};
