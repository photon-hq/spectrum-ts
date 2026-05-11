import { type ManagedStream, stream } from "../../../utils/stream";
import type { Update } from "../generated/types";
import { AlbumBuffer, messageCacheKey } from "../runtime/cache";
import { pollUpdates } from "../runtime/polling";
import type { TelegramMessage, TelegramRuntime } from "../types";
import { coalesceAlbumGroup, toTelegramMessage } from "./inbound";
import { pollAnswerEvents } from "./polls";
import { reactionEventsFromUpdate } from "./reactions";

const pickMessage = (update: Update) =>
  update.message ??
  update.edited_message ??
  update.channel_post ??
  update.edited_channel_post;

interface BuildOutput {
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
  if (update.poll) {
    // Internal cache sync only — no Spectrum event surfaced. Keeps the
    // cached poll's option list aligned with `allow_adding_options` polls.
    runtime.cache.polls.refreshPollOptions(
      update.poll.id,
      update.poll.options.map((o) => ({ title: o.text }))
    );
    return { messages: [], cacheable: false };
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

    // Per-stream because the flush callback closes over `emit`.
    const albumBuffer = runtime.cache.coalesceAlbums
      ? new AlbumBuffer({
          ...runtime.cache.albumOptions,
          flush: async (members) => {
            const grouped = coalesceAlbumGroup(members);
            if (grouped) {
              runtime.cache.messages.set(
                messageCacheKey(grouped.space.id, grouped.id),
                grouped
              );
              await emit(grouped);
            }
          },
        })
      : undefined;

    const drainAlbumsSafely = async (): Promise<void> => {
      if (!albumBuffer) {
        return;
      }
      try {
        await albumBuffer.flushAll();
      } catch {
        // logged inside flushAll()
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
        await drainAlbumsSafely();
        end();
      } catch (err) {
        // Drain inside the pump so consumers always see a final `end()`.
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
      abortController.abort();
      await pump;
    };
  });
