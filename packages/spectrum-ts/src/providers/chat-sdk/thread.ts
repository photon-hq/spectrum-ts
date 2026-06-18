// Thread handles from `(adapter, threadId)`. The host receives a thread id (not
// a thread object), so the provider builds a live handle itself via chat-SDK's
// `ThreadImpl` in its DIRECT-adapter form — `{ adapter, stateAdapter }` — which
// needs no `Chat` singleton. The handle backs both the `chatThread(space)`
// escape hatch (stamped on inbound spaces) and outbound replies.

import type { StateAdapter, ThreadImpl } from "chat";
import type { ChatAdapter, ChatMessage, ChatThread } from "./types";

/** Build (and implicitly type) a live thread handle for a thread id. */
export type MakeThread = (
  threadId: string,
  currentMessage?: ChatMessage
) => ChatThread;

/** The real `ThreadImpl` class, passed in from the lazy `await import("chat")`. */
export type ThreadImplCtor = typeof ThreadImpl;

/**
 * Bind the `ThreadImpl` class + the single adapter + state into a factory that
 * turns any thread id into a live handle. `currentMessage`, when supplied
 * (inbound), gives the handle streaming context (userId/teamId).
 */
export const createThreadFactory =
  (
    ThreadImplClass: ThreadImplCtor,
    adapter: ChatAdapter,
    state: unknown
  ): MakeThread =>
  (threadId, currentMessage) =>
    new ThreadImplClass({
      adapter,
      stateAdapter: state as StateAdapter,
      channelId: adapter.channelIdFromThreadId(threadId),
      id: threadId,
      ...(currentMessage ? { currentMessage } : {}),
    });
