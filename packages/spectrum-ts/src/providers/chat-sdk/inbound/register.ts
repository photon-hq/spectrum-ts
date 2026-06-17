// Inbound: register the chat-SDK handlers and convert each normalized event
// into Spectrum `ChatInboundMessage`(s) pushed onto the queue. The chat SDK
// routes by intent (mention / DM / subscribed thread), which is exactly the
// set a bot should see; we register all three, auto-subscribe a thread on
// first contact so follow-ups keep flowing, and ride reactions alongside.
//
// The per-event conversion lives in sibling modules: `records` (message ->
// text / attachment / link / empty records), `reaction`, plus the `attachment`,
// `link`, `enrichment`, and `space` helpers they build on.

import type { EventQueue } from "../queue";
import type {
  ChatBot,
  ChatInboundMessage,
  ChatMessage,
  ChatThread,
  ThreadRegistry,
} from "../types";
import { reactionToRecord } from "./reaction";
import { messageToRecords } from "./records";

/**
 * Wire the bot's inbound handlers to the queue. Returns nothing — the queue is
 * drained by the `messages` producer.
 */
export function registerInbound(
  bot: ChatBot,
  queue: EventQueue<ChatInboundMessage>,
  threads: ThreadRegistry
): void {
  const onMessage = async (thread: ChatThread, message: ChatMessage) => {
    // Stash the live thread so outbound can reply through it directly.
    threads.set(thread.id, thread);
    // Auto-subscribe so the rest of the conversation arrives via
    // `onSubscribedMessage` instead of needing another mention.
    await thread.subscribe?.().catch(() => undefined);
    for (const record of messageToRecords(thread, message)) {
      queue.push(record);
    }
  };

  bot.onNewMention(onMessage);
  bot.onDirectMessage(onMessage);
  bot.onSubscribedMessage(onMessage);
  bot.onReaction((event) => {
    // Both additions and removals are forwarded — `reactionToRecord` records
    // which via the reaction content's `action` field.
    threads.set(event.thread.id, event.thread);
    queue.push(reactionToRecord(event));
  });
}
