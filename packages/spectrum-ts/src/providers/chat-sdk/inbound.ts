// Inbound: register the chat-SDK handlers and convert each normalized event
// into Spectrum `ChatInboundMessage`(s) pushed onto the queue. The chat SDK
// routes by intent (mention / DM / subscribed thread), which is exactly the
// set a bot should see; we register all three, auto-subscribe a thread on
// first contact so follow-ups keep flowing, and ride reactions alongside.

import { asAttachment } from "../../content/attachment";
import { asCustom } from "../../content/custom";
import { reactionSchema } from "../../content/reaction";
import { asText } from "../../content/text";
import { asVoice } from "../../content/voice";
import type { EventQueue } from "./queue";
import type {
  ChatAttachment,
  ChatBot,
  ChatInboundMessage,
  ChatMessage,
  ChatReactionEvent,
  ChatThread,
  ThreadRegistry,
} from "./types";

const DEFAULT_MIME = "application/octet-stream";

// Resolve attachment bytes lazily: prefer the SDK's auth-aware `fetchData`,
// fall back to the URL, then to any already-fetched bytes.
const attachmentReader =
  (att: ChatAttachment): (() => Promise<Buffer>) =>
  async () => {
    if (att.fetchData) {
      return await att.fetchData();
    }
    if (att.url) {
      const res = await fetch(att.url);
      return Buffer.from(await res.arrayBuffer());
    }
    const { data } = att;
    if (data) {
      if (data instanceof Buffer) {
        return data;
      }
      return Buffer.from(await (data as Blob).arrayBuffer());
    }
    throw new Error(
      `chat-sdk: attachment "${att.name ?? "?"}" has no fetchData, url, or data`
    );
  };

const attachmentToContent = (att: ChatAttachment) => {
  const shared = {
    name: att.name ?? "attachment",
    mimeType: att.mimeType ?? DEFAULT_MIME,
    size: att.size,
    read: attachmentReader(att),
  };
  return att.type === "audio" ? asVoice(shared) : asAttachment(shared);
};

const spaceRef = (thread: ChatThread) => ({
  id: thread.id,
  adapter: thread.adapter.name,
  // The live thread — reach it via `chatThread(space)` for native
  // per-conversation calls (postEphemeral, openModal, history, …).
  thread,
  ...(thread.channelId ? { channelId: thread.channelId } : {}),
});

// One inbound chat message can fan out to a text record plus one record per
// attachment (mirrors the Slack provider's text/file split).
const messageToRecords = (
  thread: ChatThread,
  message: ChatMessage
): ChatInboundMessage[] => {
  const records: ChatInboundMessage[] = [];
  const space = spaceRef(thread);
  const sender = { id: message.author.userId };
  const timestamp = message.metadata?.dateSent ?? new Date();
  const attachments = message.attachments ?? [];

  const enrichment = {
    ...(message.isMention ? { isMention: true } : {}),
    ...(message.metadata?.edited
      ? { edited: true, editedAt: message.metadata.editedAt }
      : {}),
    ...(message.links && message.links.length > 0
      ? { links: message.links }
      : {}),
  };

  if (message.text) {
    records.push({
      id: attachments.length > 0 ? `${message.id}:text` : message.id,
      content: asText(message.text),
      sender,
      space,
      timestamp,
      ...enrichment,
    });
  }

  for (const [index, att] of attachments.entries()) {
    const single = attachments.length === 1 && !message.text;
    records.push({
      id: single ? message.id : `${message.id}:file:${index}`,
      content: attachmentToContent(att),
      sender,
      space,
      timestamp,
    });
  }

  return records;
};

const reactionToRecord = (event: ChatReactionEvent): ChatInboundMessage => {
  const space = spaceRef(event.thread);
  return {
    id: `reaction:${event.messageId}:${event.rawEmoji}`,
    content: reactionSchema.parse({
      type: "reaction",
      emoji: event.rawEmoji,
      // The SDK gives only the target id; core wraps this stub into a full
      // Message before the agent sees it (same approach as terminal).
      target: {
        id: event.messageId,
        content: asCustom({ chatsdk_type: "reaction-target", stub: true }),
        sender: { id: "__unknown__" },
        space,
        timestamp: new Date(),
      },
    }),
    sender: { id: event.user.userId },
    space,
    timestamp: new Date(),
  };
};

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
    if (event.added) {
      threads.set(event.thread.id, event.thread);
      queue.push(reactionToRecord(event));
    }
  });
}
