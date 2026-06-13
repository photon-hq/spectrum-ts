import type {
  AdvancedIMessage,
  Message as SDKMessage,
} from "@photon-ai/advanced-imessage";
import type { StreamText } from "@spectrum-ts/core";
import {
  asText,
  type ProviderMessageRecord,
} from "@spectrum-ts/core/authoring";
import { unsupportedRemoteContent } from "../shared/errors";
import { toChatGuid, toMessageGuid } from "./ids";

// Delivery pacing is fixed logic, not configurable. iMessage's native edit
// replaces the whole message body, so each update sends the full accumulated
// text. We can't know a stream's final length up front, so the gap between
// edits grows exponentially: the first edit waits `INITIAL_THROTTLE_MS`, then
// each subsequent one waits `BACKOFF_FACTOR`× longer. This spreads a fixed edit
// budget across short and long streams alike — short streams update quickly,
// long ones don't burn the budget in the opening seconds.
const INITIAL_THROTTLE_MS = 1000;
const BACKOFF_FACTOR = 2;

// iMessage caps a message at ~5 edits — the backend silently drops further
// edits, which would otherwise strand the message on an intermediate chunk and
// never show the complete text. We stay within that cap and reserve the last
// edit for the final flush (see the budget check below).
const MAX_EDITS = 5;

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
  if (content.format === "markdown") {
    // Thrown before the stream is consumed, so the send pipeline's fallback
    // can drain it and deliver the accumulated text through the `markdown`
    // chain — which lands a natively formatted message (text + UTF-16
    // formatting ranges). Streaming it here is impossible: this driver edits
    // the message in place and `messages.edit` carries no formatting, so
    // mid-stream updates would expose literal markdown source and the final
    // flush could never restore the styling.
    throw unsupportedRemoteContent(
      "streamText",
      "markdown-formatted streams have no native iMessage delivery"
    );
  }
  const chat = toChatGuid(spaceId);

  let sent: SDKMessage | undefined; // the first (and only) message we created
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
      // Send the first chunk straight away to get a message id to edit into.
      sent = await remote.messages.sendText(chat, full);
      lastSentText = full;
      lastEditAt = Date.now();
      continue;
    }

    // Once only one edit of the budget remains, stop editing mid-stream and let
    // the post-loop flush spend it — so the last edit always carries the full
    // content (we wait for everything when it's our final chance).
    const hasBudgetForInterimEdit = editCount < MAX_EDITS - 1;
    // Exponential backoff: each edit waits longer than the previous one.
    const requiredGap = INITIAL_THROTTLE_MS * BACKOFF_FACTOR ** editCount;
    if (hasBudgetForInterimEdit && Date.now() - lastEditAt >= requiredGap) {
      await flushEdit(full);
    }
  }

  if (!sent) {
    // Every non-empty delta sends immediately, so reaching here means the
    // stream yielded no text at all.
    throw unsupportedRemoteContent(
      "streamText",
      "stream produced no text — nothing to send"
    );
  }

  // Always finish on the complete text (no-op if the last edit already had it).
  await flushEdit(full);

  return {
    id: sent.guid,
    content: asText(full),
    direction: "outbound",
    space: { id: spaceId },
    timestamp: sent.dateCreated,
  };
};
