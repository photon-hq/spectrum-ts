// Space ref + the shared record base: the where / who / when stamped onto
// every inbound record fanned out from a message or reaction.

import type { ChatAdapter, ChatThread } from "../types";

// The `space` ref carried on every inbound record — identifies the conversation
// and (for messages) keeps the live thread reachable for native per-conversation
// calls. Built from `(adapter, threadId)` since the host receives those rather
// than a thread object; the live `thread` handle is passed in when we have one
// (inbound messages), absent for reactions.
export const spaceRef = (
  adapter: ChatAdapter,
  threadId: string,
  thread?: ChatThread
) => {
  const channelId =
    thread?.channelId ?? adapter.channelIdFromThreadId(threadId);
  return {
    id: threadId,
    adapter: adapter.name,
    // The live thread — reach it via `chatThread(space)` for native
    // per-conversation calls (postEphemeral, openModal, history, …).
    ...(thread ? { thread } : {}),
    ...(channelId ? { channelId } : {}),
  };
};

// Fields shared by every record fanned out from one message.
export interface RecordBase {
  sender: { id: string };
  space: ReturnType<typeof spaceRef>;
  timestamp: Date;
}
