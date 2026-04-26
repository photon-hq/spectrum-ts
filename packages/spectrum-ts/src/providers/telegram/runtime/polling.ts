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

// `message_reaction` and `message_reaction_count` must be explicitly opted
// into via `allowed_updates`; Telegram silently omits them otherwise. We
// include `message_reaction` so per-user reactions flow through without
// extra setup; `message_reaction_count` is not surfaced yet (no actor,
// snapshot semantics don't fit Spectrum's reaction content).
//
// Poll *bodies* (someone sending a poll in chat) arrive via the regular
// `message` update as `Message.poll` — no opt-in required, and the provider
// maps them to Spectrum's `poll` content type.
//
// The `poll` and `poll_answer` allowed-update kinds are intentionally NOT
// requested: they carry aggregate state / per-user vote diffs without any
// chat or message id, so faithful mapping to `poll_option` would require a
// stateful per-poll cache that this provider does not ship. Callers wanting
// raw vote events can override `allowedUpdates` and subscribe to the raw
// client.
const DEFAULT_ALLOWED_UPDATES: readonly string[] = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
];

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
