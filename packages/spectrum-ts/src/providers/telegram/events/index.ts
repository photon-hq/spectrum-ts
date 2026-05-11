import { type ManagedStream, stream } from "../../../utils/stream";
import type { Update } from "../generated/types";
import { AlbumBuffer, messageCacheKey } from "../runtime/cache";
import { pollUpdates } from "../runtime/polling";
import type { TelegramMessage, TelegramRuntime } from "../types";
import { coalesceAlbumGroup, toTelegramMessage } from "./inbound";
import { pollAnswerEvents } from "./polls";
import { reactionEventsFromUpdate } from "./reactions";

// ---------------------------------------------------------------------------
// Update → TelegramMessage[] dispatch
//
// `Update.message.poll` (poll *body*) is mapped via `pollFromTelegramPoll` in
// `./inbound`. `Update.message_reaction` is mapped to add-only reaction
// events via `./reactions`. `Update.poll_answer` is mapped to per-vote
// `poll_option` diff events via `./polls`, gated on the bot owning the poll
// (Telegram only delivers `poll_answer` for outbound non-anonymous polls;
// our `sendPoll` always pins `is_anonymous: false`). `Update.poll`
// (aggregate state — `total_voter_count`, `is_closed`) is still NOT mapped:
// Spectrum has no "poll snapshot" content type, and faithfully resolving
// "poll closed" into a per-user diff would require storing every prior vote
// vector, which is a sharper memory cost than the bounded vote-state we
// already keep for `poll_answer` resolution.
// ---------------------------------------------------------------------------

const pickMessage = (update: Update) =>
  update.message ??
  update.edited_message ??
  update.channel_post ??
  update.edited_channel_post;

interface BuildOutput {
  /** True when the messages should be cached individually before emit. */
  cacheable: boolean;
  messages: TelegramMessage[];
}

const buildMessages = (
  runtime: TelegramRuntime,
  update: Update
): BuildOutput => {
  if (update.message_reaction) {
    return {
      messages: reactionEventsFromUpdate(
        update.message_reaction,
        update.update_id,
        runtime.cache
      ),
      cacheable: false,
    };
  }
  if (update.poll_answer) {
    return {
      messages: pollAnswerEvents(update.poll_answer, runtime.cache, update),
      cacheable: false,
    };
  }
  const tgMessage = pickMessage(update);
  if (!tgMessage) {
    return { messages: [], cacheable: false };
  }
  const message = toTelegramMessage(runtime.client, tgMessage);
  return {
    messages: message ? [message] : [],
    cacheable: true,
  };
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

    // Album coalescing buffer is per-stream-lifetime: its flush callback
    // closes over `emit`, so it only exists while the consumer is connected.
    // On teardown we flush whatever is in flight so partial albums still
    // surface (otherwise an album that arrived right before close would be
    // dropped).
    const albumBuffer = runtime.cache.coalesceAlbums
      ? new AlbumBuffer({
          ...runtime.cache.albumOptions,
          flush: async (members) => {
            const grouped = coalesceAlbumGroup(members);
            if (grouped) {
              // Overwrite the lead member's cache entry with the coalesced
              // wrapper so `getMessage(grouped.id)` and reaction-target
              // hydration return the same record consumers see on the
              // stream. The wrapper's id is anchored to the first member's
              // real `message_id` (see `coalesceAlbumGroup` in `./inbound`),
              // which collides with the per-member write that happened
              // upstream — without this overwrite, the cache would still
              // resolve to the lone child's text/media content rather than
              // the `group` wrapper. The remaining album members stay
              // individually addressable under their own ids. Mirrors the
              // outbound `sendGroupContent` cache write in `../messages.ts`.
              runtime.cache.messages.set(
                messageCacheKey(grouped.space.id, grouped.id),
                grouped
              );
              await emit(grouped);
            }
          },
        })
      : undefined;

    // Drain any in-flight album batches through `emit`. Must run *inside*
    // the pump (before `end()` is called and while no concurrent push can
    // occur) so we don't race with new members arriving on the next poll
    // cycle and don't try to emit on a stopped Repeater. Failures here are
    // logged-and-swallowed by `AlbumBuffer.flushAll` itself, so this never
    // throws — but we still wrap defensively so a future change can't
    // accidentally skip the subsequent `end(...)` call.
    const drainAlbumsSafely = async (): Promise<void> => {
      if (!albumBuffer) {
        return;
      }
      try {
        await albumBuffer.flushAll();
      } catch {
        // Swallow: individual flush errors are already routed through the
        // buffer's own catch path; this is just belt-and-braces against an
        // unexpected throw bubbling up and skipping `end()`.
      }
    };

    const pump = (async () => {
      try {
        for await (const update of pollUpdates(
          runtime.client,
          abortController.signal,
          options
        )) {
          const built = buildMessages(runtime, update);
          for (const message of built.messages) {
            if (built.cacheable) {
              runtime.cache.messages.set(
                messageCacheKey(message.space.id, message.id),
                message
              );
            }
            // Album members go into the buffer instead of emitting directly.
            // Each album member is still cached above so per-item
            // `getMessage` keeps working even when the buffer coalesces them.
            if (
              albumBuffer &&
              built.cacheable &&
              message.mediaGroupId !== undefined
            ) {
              albumBuffer.push(message.mediaGroupId, message);
              continue;
            }
            await emit(message);
          }
        }
        // `pollUpdates` returned cleanly (it's an infinite generator under
        // normal use, so this branch is mostly defensive). Drain any
        // buffered album batches before signalling end-of-stream.
        await drainAlbumsSafely();
        end();
      } catch (err) {
        // Aborted teardown: drain buffered albums first so the final batch
        // still surfaces, *then* close the stream. Doing the drain inside
        // the pump (rather than the disposer) means no concurrent
        // `albumBuffer.push()` from this same loop can race with the
        // flush — by the time we're in catch, the for-await has stopped
        // pulling new updates. It also means a flush failure no longer
        // skips `end()` and leaves the consumer hanging.
        if (abortController.signal.aborted) {
          await drainAlbumsSafely();
          end();
          return;
        }
        await drainAlbumsSafely();
        end(err);
      }
    })();

    return async () => {
      signal.removeEventListener("abort", onSignalAbort);
      // The pump owns its own teardown sequence (drain → end). Aborting
      // the controller wakes the in-flight `getUpdates`, the catch block
      // runs `drainAlbumsSafely() → end()`, and `await pump` waits for
      // that to settle. No work happens here that could race with the
      // pump.
      abortController.abort();
      await pump;
    };
  });
