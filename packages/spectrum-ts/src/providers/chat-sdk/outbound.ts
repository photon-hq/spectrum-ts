// Outbound: map a Spectrum `Content` to a chat-SDK `thread.post()` (or an
// adapter-level reaction/edit/delete). Everything routes through the SDK's
// normalized API — no per-platform code — so the wrapper stays generic across
// every adapter, present and future. Content the SDK can't express surfaces as
// `UnsupportedError`, which the send pipeline warns-and-skips.

import type { BaseContent, Content } from "../../content/types";
import type { ProviderMessageRecord } from "../../platform/build";
import { UnsupportedError } from "../../utils/errors";
import type {
  ChatBot,
  ChatPostable,
  ChatThread,
  ThreadRegistry,
} from "./types";

const PLATFORM_LABEL = "ChatSDK";

// Convert the "body" content types (text/markdown/stream/file) into something
// `post()` accepts. Used for top-level sends and for the inner content of a
// reply/edit.
const toPostable = async (content: BaseContent): Promise<ChatPostable> => {
  switch (content.type) {
    case "text":
      return content.text;
    case "markdown":
      return { markdown: content.markdown };
    case "streamText":
      // Native streaming: the SDK edits the message in place as deltas arrive.
      return content.stream();
    case "custom":
      // Universal escape hatch: forward the raw payload straight to the
      // adapter's `post()`. Lets you send anything the chat SDK accepts
      // (cards, PostableObjects like Plan/Poll, markdown+files) without the
      // wrapper modeling each — `space.send(custom({ card: … }))`.
      return content.raw as ChatPostable;
    case "attachment":
    case "voice":
      return {
        markdown: "",
        files: [
          {
            data: await content.read(),
            filename: content.name ?? "attachment",
            mimeType: content.mimeType,
          },
        ],
      };
    default:
      throw UnsupportedError.content(content.type, PLATFORM_LABEL);
  }
};

const toRecord = (
  sentId: string,
  content: Content,
  space: { id: string }
): ProviderMessageRecord => ({
  id: sentId,
  content,
  space,
  timestamp: new Date(),
});

export async function sendContent(
  bot: ChatBot,
  threads: ThreadRegistry,
  space: { id: string },
  content: Content
): Promise<ProviderMessageRecord | undefined> {
  // Prefer the live thread from the inbound event (key-agnostic); fall back to
  // reconstructing from the id for proactive sends to a never-seen space.
  const thread: ChatThread = threads.get(space.id) ?? bot.thread(space.id);

  switch (content.type) {
    case "typing":
      await thread.startTyping?.().catch(() => undefined);
      return;
    case "read":
      // No generic read-receipt API across adapters.
      return;
    case "reaction":
      await thread.adapter.addReaction(
        thread.id,
        content.target.id,
        content.emoji
      );
      return toRecord(
        `reaction:${content.target.id}:${content.emoji}`,
        content,
        space
      );
    case "unsend":
      if (!thread.adapter.deleteMessage) {
        throw UnsupportedError.action("unsend", PLATFORM_LABEL);
      }
      await thread.adapter.deleteMessage(thread.id, content.target.id);
      return;
    case "edit": {
      if (!thread.adapter.editMessage) {
        throw UnsupportedError.action("edit", PLATFORM_LABEL);
      }
      const postable = await toPostable(content.content);
      await thread.adapter.editMessage(thread.id, content.target.id, postable);
      return;
    }
    case "reply": {
      // Threads ARE the reply unit — post the inner content into the thread.
      const sent = await thread.post(await toPostable(content.content));
      return toRecord(sent.id, content, space);
    }
    default: {
      const sent = await thread.post(await toPostable(content));
      return toRecord(sent.id, content, space);
    }
  }
}
