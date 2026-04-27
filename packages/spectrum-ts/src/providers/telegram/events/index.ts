import { type ManagedStream, stream } from "../../../utils/stream";
import type { Update } from "../generated/types";
import type { TelegramClient } from "../runtime/client";
import { pollUpdates } from "../runtime/polling";
import type { TelegramMessage, TelegramRuntime } from "../types";
import { toTelegramMessage } from "./inbound";
import { reactionEventsFromUpdate } from "./reactions";

// ---------------------------------------------------------------------------
// Update → TelegramMessage[] dispatch
//
// Telegram surfaces a few related update kinds we deliberately do NOT map to
// universal Spectrum events:
//   - `Update.poll`         — aggregate poll state changes (vote totals,
//                             closure). Bots only receive these for polls
//                             they sent themselves. Not mapped: there is no
//                             chat/message id on this update, and Spectrum
//                             has no "poll snapshot" content type.
//   - `Update.poll_answer`  — per-user vote diff in non-anonymous polls.
//                             Not mapped to `poll_option`: faithful
//                             resolution requires a per-poll cache
//                             (`poll_answer` omits chat, message id, and
//                             option text), and we don't ship a stateful
//                             cache from this provider.
// Callers wanting either can override `allowedUpdates` and subscribe to the
// raw client directly. The poll *body* (Update.message.poll) IS mapped — see
// `pollFromTelegramPoll` in `./inbound`.
// ---------------------------------------------------------------------------

const pickMessage = (update: Update) =>
  update.message ??
  update.edited_message ??
  update.channel_post ??
  update.edited_channel_post;

const buildMessages = (
  client: TelegramClient,
  update: Update
): TelegramMessage[] => {
  if (update.message_reaction) {
    return reactionEventsFromUpdate(update.message_reaction, update.update_id);
  }
  const tgMessage = pickMessage(update);
  if (!tgMessage) {
    return [];
  }
  const message = toTelegramMessage(client, tgMessage);
  return message ? [message] : [];
};

export interface MessagesOptions {
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
  timeout?: number;
}

export const messages = (
  runtime: TelegramRuntime,
  signal: AbortSignal,
  options: MessagesOptions = {}
): ManagedStream<TelegramMessage> =>
  stream<TelegramMessage>((emit, end) => {
    const abortController = new AbortController();
    const onSignalAbort = () => abortController.abort(signal.reason);
    if (signal.aborted) {
      abortController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    const pump = (async () => {
      try {
        for await (const update of pollUpdates(
          runtime.client,
          abortController.signal,
          options
        )) {
          const built = buildMessages(runtime.client, update);
          for (const message of built) {
            await emit(message);
          }
        }
        end();
      } catch (err) {
        if (abortController.signal.aborted) {
          end();
          return;
        }
        end(err);
      }
    })();

    return async () => {
      signal.removeEventListener("abort", onSignalAbort);
      abortController.abort();
      await pump;
    };
  });
