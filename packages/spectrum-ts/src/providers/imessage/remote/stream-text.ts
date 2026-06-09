import type {
  AdvancedIMessage,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage";
import type { StreamText } from "../../../content/stream-text";
import { asText } from "../../../content/text";
import type { ProviderMessageRecord } from "../../../platform/types";
import { unsupportedRemoteContent } from "../shared/errors";
import { toChatGuid, toMessageGuid } from "./ids";

// iMessage's native edit replaces the whole message body, so each update sends
// the full accumulated text. Edits are throttled to keep the round-trip rate
// sane; the default is a balance between feeling live and not flooding the
// chat. Callers tune via `streamText(source, { throttleMs })`.
const DEFAULT_THROTTLE_MS = 1500;

// iMessage caps a message at ~5 edits — the backend silently drops further
// edits, which would otherwise strand the message on an intermediate chunk and
// never show the complete text. Default the budget to that cap so we always
// have room for the final flush; one edit is reserved for it (see below).
// Callers raise/lower it via `streamText(source, { maxEdits })`.
const DEFAULT_MAX_EDITS = 5;

/**
 * Deliver a `streamText` content by sending the first chunk as a real message
 * and editing it in place as more text arrives. The stream materializes into a
 * normal text message: the returned record carries `asText(fullText)` with the
 * first send's id and timestamp.
 */
export const sendStreamText = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: StreamText
): Promise<ProviderMessageRecord> => {
  const chat = toChatGuid(spaceId);
  const throttleMs = content.throttleMs ?? DEFAULT_THROTTLE_MS;
  const maxEdits = content.maxEdits ?? DEFAULT_MAX_EDITS;
  const { firstChunkChars } = content;

  let sent: SDKMessage | undefined; // the first (and only) message we created
  let buffer = ""; // text accumulated before the first send
  let full = ""; // everything seen so far
  let lastSentText = ""; // last text actually pushed to iMessage
  let lastEditAt = 0;
  let editCount = 0;

  const flushEdit = async (text: string): Promise<void> => {
    if (!sent || text === lastSentText) {
      return; // nothing to send, or already up to date
    }
    await remote.messages.edit(chat, toMessageGuid(sent.guid), text);
    lastSentText = text;
    lastEditAt = Date.now();
    editCount += 1;
  };

  for await (const delta of content.stream()) {
    full += delta;

    if (!sent) {
      buffer += delta;
      const ready = firstChunkChars
        ? buffer.length >= firstChunkChars
        : buffer.length > 0;
      if (ready) {
        sent = await remote.messages.sendText(chat, buffer);
        lastSentText = buffer;
        lastEditAt = Date.now();
        buffer = "";
      }
      continue;
    }

    // Reserve one edit from the budget for the guaranteed final flush, so
    // whatever text is still pending always lands on the last edit.
    const withinBudget = editCount < maxEdits - 1;
    if (withinBudget && Date.now() - lastEditAt >= throttleMs) {
      await flushEdit(full);
    }
  }

  if (!sent) {
    if (full.length === 0) {
      throw unsupportedRemoteContent(
        "streamText",
        "stream produced no text — nothing to send"
      );
    }
    // The stream ended before reaching `firstChunkChars`; send what we have.
    sent = await remote.messages.sendText(chat, full);
    lastSentText = full;
  }

  // Always finish on the complete text (no-op if the last edit already had it).
  await flushEdit(full);

  return {
    id: sent.guid,
    content: asText(full),
    space: { id: spaceId },
    timestamp: sent.dateCreated,
  };
};
