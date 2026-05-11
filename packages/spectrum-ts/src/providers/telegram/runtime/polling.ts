import type { Update } from "../generated/types";
import type { TelegramClient } from "./client";

export interface PollingOptions {
  /**
   * When omitted we opt into `DEFAULT_ALLOWED_UPDATES` so reactions surface for
   * admin bots without configuration. Pass an explicit list (including an empty
   * list, which Telegram interprets as "all except the opt-in-only types") to
   * override.
   */
  allowedUpdates?: string[];
  /** Discard any updates queued before polling starts. */
  dropPendingUpdates?: boolean;
  /** Long-polling timeout in seconds; Telegram caps at 50. */
  timeout?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
// Telegram caps `getUpdates.timeout` at 50s server-side; negative or
// non-finite values cause a 400. `configSchema` already gates this, but
// `pollUpdates` accepts a direct options override too.
const MAX_TIMEOUT_SECONDS = 50;

const sanitizeTimeout = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  // `timeout` is integer-valued; truncate rather than round to match
  // `z.number().int()` behaviour.
  const normalized = Math.trunc(raw);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > MAX_TIMEOUT_SECONDS) {
    return MAX_TIMEOUT_SECONDS;
  }
  return normalized;
};

// `message_reaction` and `poll_answer` are opt-in: Telegram omits them
// otherwise. `message_reaction_count` is intentionally excluded (snapshot
// semantics don't fit Spectrum's reaction content); `poll` aggregate
// updates are excluded because Spectrum has no poll-snapshot content type.
const DEFAULT_ALLOWED_UPDATES: readonly string[] = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "poll_answer",
];

// `offset: -1` returns at most the most recent pending update; advancing
// past it confirms (and therefore drops) every older queued update.
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
