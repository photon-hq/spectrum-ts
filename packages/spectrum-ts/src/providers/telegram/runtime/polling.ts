import type { Update } from "../generated/types";
import type { TelegramClient } from "./client";

export interface PollingOptions {
  /** Omitted = `DEFAULT_ALLOWED_UPDATES`. Empty array = Telegram's default. */
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
  /** Long-polling timeout in seconds; Telegram caps at 50. */
  timeout?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 50;

const sanitizeTimeout = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const normalized = Math.trunc(raw);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > MAX_TIMEOUT_SECONDS) {
    return MAX_TIMEOUT_SECONDS;
  }
  return normalized;
};

// `message_reaction`, `poll`, and `poll_answer` are opt-in.
// `message_reaction_count` aggregates are excluded — no Spectrum content
// type maps to them. `poll` is consumed internally to keep the cached
// option list in sync for `allow_adding_options` polls.
const DEFAULT_ALLOWED_UPDATES: readonly string[] = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "poll",
  "poll_answer",
];

// `offset: -1` returns the most recent pending update; advancing past it
// confirms-and-drops every older queued update.
const discardPendingUpdates = async (
  client: TelegramClient,
  signal: AbortSignal
): Promise<number> => {
  const tail = await client.invoke(
    "getUpdates",
    { offset: -1, timeout: 0 },
    signal
  );
  const last = tail.at(-1);
  return last ? last.update_id + 1 : 0;
};

export async function* pollUpdates(
  client: TelegramClient,
  signal: AbortSignal,
  options: PollingOptions = {}
): AsyncIterable<Update> {
  const timeout = sanitizeTimeout(options.timeout);
  const allowedUpdates = options.allowedUpdates ?? [...DEFAULT_ALLOWED_UPDATES];
  let offset = 0;

  if (options.dropPendingUpdates) {
    try {
      offset = await discardPendingUpdates(client, signal);
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      throw err;
    }
  }

  while (!signal.aborted) {
    let batch: Update[];
    try {
      batch = await client.invoke(
        "getUpdates",
        { offset, timeout, allowed_updates: allowedUpdates },
        signal
      );
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      throw err;
    }

    for (const update of batch) {
      if (signal.aborted) {
        return;
      }
      yield update;
      offset = update.update_id + 1;
    }
  }
}
