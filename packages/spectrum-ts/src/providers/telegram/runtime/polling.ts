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

// Telegram caps long-polling server-side at ~50s regardless of what the
// caller asks for (the Bot API docs don't publish a hard maximum, but
// every observation in the wild — including TDLib/python-telegram-bot
// issue trackers — bottoms out at 50). Anything above that just round-
// trips at 50; anything negative or non-finite causes `getUpdates` to
// 400 and would tear down the polling loop. The `configSchema` Zod gate
// already enforces this at config time, but a runtime clamp keeps the
// invariant true even if a future call site bypasses validation (e.g.
// a programmatic options override passed directly into `pollUpdates`).
const MAX_TIMEOUT_SECONDS = 50;

const sanitizeTimeout = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  if (raw < 0) {
    return 0;
  }
  if (raw > MAX_TIMEOUT_SECONDS) {
    return MAX_TIMEOUT_SECONDS;
  }
  return raw;
};

// `message_reaction`, `message_reaction_count`, and `poll_answer` must be
// explicitly opted into via `allowed_updates`; Telegram silently omits them
// otherwise. We include:
//
//   - `message_reaction` so per-user reactions flow through without extra
//     setup. `message_reaction_count` is NOT requested — its snapshot
//     semantics don't fit Spectrum's reaction content (no actor).
//
//   - `poll_answer` so per-vote diff events surface as `poll_option`
//     content. Telegram only delivers this for non-anonymous polls a bot
//     sent itself; resolution requires the runtime cache populated by
//     `sendPoll`. With the cache disabled (`cache.polls = 0`), updates
//     still arrive but `pollAnswerEvents` drops them silently.
//
// Poll *bodies* (someone sending a poll in chat) arrive via the regular
// `message` update as `Message.poll` — no opt-in required, and the provider
// maps them to Spectrum's `poll` content type.
//
// `poll` (aggregate vote totals / closure) is still NOT requested: Spectrum
// has no "poll snapshot" content type, and faithfully translating "poll
// closed" into per-user diffs would require keeping every prior vote vector
// for every poll, a sharper memory cost than the bounded per-user state we
// already keep for `poll_answer` resolution.
const DEFAULT_ALLOWED_UPDATES: readonly string[] = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "poll_answer",
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
