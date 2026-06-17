// Space ref + the shared record base: the where / who / when stamped onto
// every inbound record fanned out from a message or reaction.

import type { ChatThread } from "../types";

// The `space` ref carried on every inbound record — identifies the conversation
// and keeps the live thread reachable for native per-conversation calls.
export const spaceRef = (thread: ChatThread) => ({
  id: thread.id,
  adapter: thread.adapter.name,
  // The live thread — reach it via `chatThread(space)` for native
  // per-conversation calls (postEphemeral, openModal, history, …).
  thread,
  ...(thread.channelId ? { channelId: thread.channelId } : {}),
});

// Fields shared by every record fanned out from one message.
export interface RecordBase {
  sender: { id: string };
  space: ReturnType<typeof spaceRef>;
  timestamp: Date;
}
