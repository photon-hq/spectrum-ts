import { sendMessageDraft } from "@photon-ai/telegram-ts";
import type { StreamText } from "../../../content/stream-text";
import { asText } from "../../../content/text";
import type { ProviderMessageRecord } from "../../../platform/types";
import { UnsupportedError } from "../../../utils/errors";
import { executeSpec, type TelegramClient } from "../client";
import { TELEGRAM_PLATFORM } from "../config";
import type { TelegramSpace } from "../space";

const MILLIS_PER_SECOND = 1000;

// Drafts are ephemeral previews replaced wholesale on every update and carry
// no edit cap (unlike iMessage), so a fixed gap is enough pacing: frequent
// enough to feel live, infrequent enough to stay clear of Bot API rate limits.
const DRAFT_THROTTLE_MS = 500;

// `draft_id` must be non-zero, and updates reusing an id animate in place. A
// process-local counter gives each stream its own draft, so concurrent streams
// into the same chat don't overwrite each other's preview.
let nextDraftId = 1;

/**
 * Deliver a `streamText` content natively via Telegram message drafts
 * (`sendMessageDraft`): an empty draft shows the client's "Thinking…"
 * placeholder, throttled updates animate the accumulated text while the stream
 * runs, and a final `sendMessage` persists the full text — drafts are
 * ~30-second ephemeral previews, so only a real send lands in the chat.
 * Drafts exist only in private chats; group/channel spaces (non-positive chat
 * ids) throw `UnsupportedError` before the stream is consumed, letting the
 * send pipeline's plain-text fallback deliver the accumulated text instead.
 */
export const sendStreamText = async (
  client: TelegramClient,
  space: TelegramSpace,
  content: StreamText
): Promise<ProviderMessageRecord> => {
  const chatId = Number(space.id);
  if (!(Number.isInteger(chatId) && chatId > 0)) {
    throw UnsupportedError.content(
      "streamText",
      TELEGRAM_PLATFORM,
      `message drafts work only in private chats (got chat id "${space.id}").`
    );
  }
  const draftId = nextDraftId;
  nextDraftId += 1;

  let lastDraftText: string | undefined;
  let lastDraftAt = 0;
  let draftsAvailable = true;

  const updateDraft = async (text: string): Promise<void> => {
    if (!draftsAvailable || text === lastDraftText) {
      return;
    }
    try {
      await sendMessageDraft({
        body: { chat_id: chatId, draft_id: draftId, text },
        client,
      });
      lastDraftText = text;
      lastDraftAt = Date.now();
    } catch {
      // The draft is only a preview — never let it sink the send. One failure
      // disables further drafts (a Bot API server without `sendMessageDraft`
      // would reject every call); the final `sendMessage` still delivers.
      draftsAvailable = false;
    }
  };

  // Telegram renders an empty draft as its native "Thinking…" placeholder,
  // covering the gap until the first token arrives.
  await updateDraft("");

  let full = "";
  for await (const delta of content.stream()) {
    full += delta;
    if (Date.now() - lastDraftAt >= DRAFT_THROTTLE_MS) {
      await updateDraft(full);
    }
  }

  if (!full) {
    // The stream is already consumed, so the pipeline's plain-text fallback
    // cannot apply — this lands in warn-and-skip. The lingering "Thinking…"
    // draft expires on its own.
    throw UnsupportedError.content(
      "streamText",
      TELEGRAM_PLATFORM,
      "stream produced no text — nothing to send."
    );
  }

  // Persist: only a real `sendMessage` lands the message in the chat (and
  // replaces the draft client-side).
  const sent = await executeSpec(client, {
    method: "sendMessage",
    params: { chat_id: space.id, text: full },
  });
  return {
    id: String(sent.message_id),
    content: asText(full),
    space: { id: space.id },
    timestamp: new Date(sent.date * MILLIS_PER_SECOND),
  };
};
