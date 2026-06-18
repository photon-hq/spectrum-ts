// Outbound: map a Spectrum `Content` to a chat-SDK `thread.post()` (or an
// adapter-level reaction/edit/delete). Everything routes through the SDK's
// normalized thread API — no per-platform code — so the provider stays generic
// across every adapter, present and future. Content the SDK can't express
// surfaces as `UnsupportedError`, which the send pipeline warns-and-skips.

import type { AdapterPostableMessage } from "chat";
import type { BaseContent, Content } from "../../content/types";
import type { ProviderMessageRecord } from "../../platform/build";
import { UnsupportedError } from "../../utils/errors";
import type { MakeThread } from "./thread";
import type { ChatFileUpload, ChatThread, ThreadRegistry } from "./types";

// The postable forms this provider PRODUCES from Spectrum content. A subset of
// what chat's `Thread.post()` accepts (`string | PostableMessage | ChatElement`,
// where `PostableMessage` includes `AsyncIterable<string>` for streaming), so it
// passes straight through to `post()`.
type ChatObjectPostable =
  | { markdown: string; files?: ChatFileUpload[] }
  | { raw: string; files?: ChatFileUpload[] };

type ChatPostable = string | ChatObjectPostable | AsyncIterable<string>;

// What outbound needs from the platform client: the live-thread cache (populated
// by the host on inbound), a factory to reconstruct a handle for proactive sends
// to a never-seen space, and the adapter name for `UnsupportedError` messages.
export interface OutboundClient {
  label: string;
  makeThread: MakeThread;
  threads: ThreadRegistry;
}

// Convert the "body" content types (text/markdown/stream/file) into something
// `post()` accepts. Used for top-level sends and for the inner content of a
// reply/edit.
const toPostable = async (
  content: BaseContent,
  label: string
): Promise<ChatPostable> => {
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
      // provider modeling each — `space.send(custom({ card: … }))`.
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
      throw UnsupportedError.content(content.type, label);
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
  client: OutboundClient,
  space: { id: string },
  content: Content
): Promise<ProviderMessageRecord | undefined> {
  const { label, threads, makeThread } = client;
  // Prefer the live thread cached from the inbound event (carries streaming
  // context); fall back to reconstructing one from the id for proactive sends.
  const thread: ChatThread = threads.get(space.id) ?? makeThread(space.id);

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
        throw UnsupportedError.action("unsend", label);
      }
      await thread.adapter.deleteMessage(thread.id, content.target.id);
      return;
    case "edit": {
      // `editMessage` is required on chat's `Adapter` type, but a custom adapter
      // can still omit it at runtime — guard and surface a clear error.
      if (!thread.adapter.editMessage) {
        throw UnsupportedError.action("edit", label);
      }
      const postable = await toPostable(content.content, label);
      // `editMessage` takes an `AdapterPostableMessage` — the non-streaming
      // subset of what `post()` accepts. Our text/markdown/file postables are in
      // that subset; a streaming edit is nonsensical, so the cast is safe.
      await thread.adapter.editMessage(
        thread.id,
        content.target.id,
        postable as AdapterPostableMessage
      );
      return;
    }
    case "reply": {
      // Threads ARE the reply unit — post the inner content into the thread.
      const sent = await thread.post(await toPostable(content.content, label));
      return toRecord(sent.id, content, space);
    }
    default: {
      const sent = await thread.post(await toPostable(content, label));
      return toRecord(sent.id, content, space);
    }
  }
}
