import type { Update } from "../generated/types";
import type { TelegramClient } from "./client";

export interface PollingOptions {
  /** Empty / omitted yields all update types except `chat_member`. */
  allowedUpdates?: string[];
  /** Discard any updates queued before polling starts. */
  dropPendingUpdates?: boolean;
  /** Long-polling timeout in seconds; Telegram caps at 50. */
  timeout?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;

// offset: -1 returns at most the most recent pending update; confirming it
// advances Telegram's queue past every older update without surfacing them.
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
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const allowedUpdates = options.allowedUpdates;
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
        {
          offset,
          timeout,
          ...(allowedUpdates ? { allowed_updates: allowedUpdates } : {}),
        },
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
