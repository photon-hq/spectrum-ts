import type { Poll as SpectrumPoll } from "../../../content/poll";
import type { TelegramMessage } from "../types";

// ---------------------------------------------------------------------------
// LRU primitive
//
// In-process, capacity-bounded LRU. No TTL — a cached `TelegramMessage` does
// not expire in any meaningful way: ids, content, sender and timestamp are
// stable; the lazy `getFile` closure on attachments re-fetches a fresh URL
// on every `read()` so the ~1h Telegram file-URL window doesn't leak in.
// Bounding by capacity is enough; eviction is silent (no events, no counters).
//
// Implementation note: leverages the insertion-order guarantee on `Map` —
// every read deletes-and-reinserts the entry to mark it as most-recent, every
// write evicts the oldest key when over capacity. O(1) per operation.
// ---------------------------------------------------------------------------

const DISABLED_CAPACITY = 0;

export class TelegramLRU<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 0) {
      throw new Error(
        `TelegramLRU: capacity must be a non-negative finite number, got ${capacity}`
      );
    }
    this.capacity = capacity;
  }

  get enabled(): boolean {
    return this.capacity > DISABLED_CAPACITY;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.enabled) {
      return;
    }
    const value = this.entries.get(key);
    if (value === undefined) {
      return;
    }
    // Reinsert to mark as most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (!this.enabled) {
      return;
    }
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Album-buffer slot
//
// Telegram albums (multiple media composed into a single user-facing post)
// arrive as separate `Update`s sharing a `media_group_id`. The Bot API gives
// no "album finished" signal, so we debounce: each new member arms a flush
// timer; if no new member arrives within `debounceMs`, we emit the buffer as
// a single `group`. A hard `ceilingMs` ensures a stuck buffer never leaks
// (e.g. if the upstream stream pauses mid-album for a network blip).
//
// This slot is structurally different from `TelegramLRU` — entries are keyed
// by `media_group_id`, hold a list-plus-timers, and are removed on flush
// rather than evicted by capacity. Capacity here is a *concurrency* cap on
// in-flight albums; if exceeded, the oldest in-flight buffer flushes early.
// ---------------------------------------------------------------------------

export interface AlbumBufferEntry {
  ceilingTimer: ReturnType<typeof setTimeout>;
  debounceTimer: ReturnType<typeof setTimeout>;
  members: TelegramMessage[];
}

export interface AlbumBufferOptions {
  ceilingMs: number;
  /** Max concurrent in-flight albums; oldest flushes early on overflow. */
  concurrentCapacity: number;
  debounceMs: number;
  flush: (members: TelegramMessage[]) => Promise<void> | void;
}

export class AlbumBuffer {
  private readonly inFlight = new Map<string, AlbumBufferEntry>();
  private readonly options: AlbumBufferOptions;

  constructor(options: AlbumBufferOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.concurrentCapacity > DISABLED_CAPACITY;
  }

  push(mediaGroupId: string, member: TelegramMessage): void {
    if (!this.enabled) {
      return;
    }
    const existing = this.inFlight.get(mediaGroupId);
    if (existing) {
      existing.members.push(member);
      clearTimeout(existing.debounceTimer);
      existing.debounceTimer = this.armDebounce(mediaGroupId);
      return;
    }
    if (this.inFlight.size >= this.options.concurrentCapacity) {
      const oldestKey = this.inFlight.keys().next().value;
      if (oldestKey !== undefined) {
        this.flush(oldestKey);
      }
    }
    const entry: AlbumBufferEntry = {
      members: [member],
      debounceTimer: this.armDebounce(mediaGroupId),
      ceilingTimer: this.armCeiling(mediaGroupId),
    };
    this.inFlight.set(mediaGroupId, entry);
  }

  /**
   * Flush every in-flight buffer immediately and clear timers, awaiting all
   * pending flush callbacks. Called on provider teardown so the parent
   * stream sees the final batches instead of losing in-progress albums to
   * the race between teardown and the debounce/ceiling timers.
   *
   * Errors from individual flushes are swallowed (and logged) inside
   * `flush()` itself — same fire-and-forget contract as the timer-driven
   * paths — so the returned promise resolves once all callbacks settle,
   * regardless of individual outcomes.
   */
  async flushAll(): Promise<void> {
    await Promise.all([...this.inFlight.keys()].map((key) => this.flush(key)));
  }

  // Timer paths intentionally do not await `flush()` — there is no consumer
  // to surface a rejection to. `flush()` swallows + logs internally, so the
  // returned promise can only resolve; we attach a no-op `.catch` purely to
  // satisfy the lint that disallows orphaned floating promises.
  private armDebounce(mediaGroupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flush(mediaGroupId).catch(() => {
        /* swallowed inside flush() */
      });
    }, this.options.debounceMs);
  }

  private armCeiling(mediaGroupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flush(mediaGroupId).catch(() => {
        /* swallowed inside flush() */
      });
    }, this.options.ceilingMs);
  }

  private async flush(mediaGroupId: string): Promise<void> {
    const entry = this.inFlight.get(mediaGroupId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.debounceTimer);
    clearTimeout(entry.ceilingTimer);
    this.inFlight.delete(mediaGroupId);
    // Errors are swallowed and logged rather than re-thrown: timer-driven
    // paths have no awaiter to receive the rejection, and re-throwing
    // would surface as an unhandled rejection that crashes the host
    // process. `flushAll()` callers awaiting this promise see resolution
    // (with a logged failure) instead of a thrown error — same effective
    // contract whether the call originated from a timer or teardown.
    try {
      await this.options.flush(entry.members);
    } catch (err) {
      console.error("Telegram album flush failed:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Poll vote-state
//
// `poll_id → { poll, chatId, messageId }` is written once per outbound
// `sendPoll`. `(poll_id, user_id) → optionIndexes` is updated on every
// `poll_answer` so we can compute the (added, removed) diff against
// Telegram's "current vote vector" payload and produce Spectrum's
// `selected: true` / `selected: false` events with iMessage-equivalent
// fidelity (see PR #35 contract).
// ---------------------------------------------------------------------------

export interface CachedPoll {
  /**
   * Snapshot of the chat where the poll was sent. Telegram's `poll_answer`
   * update carries no chat info; we restore it from this snapshot when
   * synthesizing per-vote events. Stored as the same shape `chatToSpace`
   * produces so consumers see a consistent `space` field across all
   * Telegram event kinds.
   */
  chat: {
    chatId: number;
    id: string;
    title?: string;
    type: "private" | "group" | "supergroup" | "channel";
    username?: string;
  };
  messageId: number;
  poll: SpectrumPoll;
}

const voteKey = (pollId: string, userId: number): string =>
  `${pollId}:${userId}`;

export class PollStore {
  readonly polls: TelegramLRU<string, CachedPoll>;
  readonly votes: TelegramLRU<string, readonly number[]>;

  constructor(pollCapacity: number, voteCapacity: number) {
    this.polls = new TelegramLRU(pollCapacity);
    this.votes = new TelegramLRU(voteCapacity);
  }

  rememberPoll(pollId: string, value: CachedPoll): void {
    this.polls.set(pollId, value);
  }

  resolvePoll(pollId: string): CachedPoll | undefined {
    return this.polls.get(pollId);
  }

  priorVote(pollId: string, userId: number): readonly number[] {
    return this.votes.get(voteKey(pollId, userId)) ?? [];
  }

  recordVote(
    pollId: string,
    userId: number,
    optionIds: readonly number[]
  ): void {
    this.votes.set(voteKey(pollId, userId), optionIds);
  }
}

// ---------------------------------------------------------------------------
// Top-level cache surface attached to TelegramRuntime
// ---------------------------------------------------------------------------

export interface TelegramCacheCapacities {
  albumConcurrent: number;
  messages: number;
  polls: number;
  pollVotes: number;
}

export interface TelegramCacheTimings {
  albumCeilingMs: number;
  albumDebounceMs: number;
}

export interface TelegramCacheOptions extends TelegramCacheTimings {
  capacity: TelegramCacheCapacities;
  coalesceAlbums: boolean;
}

export const DEFAULT_CACHE_OPTIONS: TelegramCacheOptions = {
  capacity: {
    messages: 5000,
    polls: 500,
    pollVotes: 5000,
    albumConcurrent: 100,
  },
  albumDebounceMs: 500,
  albumCeilingMs: 2000,
  coalesceAlbums: false,
};

// Album buffering is owned by the events module (`./events/index.ts`) rather
// than the cache, because the flush callback needs the stream's `emit` —
// which only exists for the lifetime of the `messages()` subscription, not
// the runtime. The cache exposes the *configuration* (`coalesceAlbums` flag
// and timings) so the events module can construct an `AlbumBuffer` per
// stream lifecycle.
// Composite cache key for the messages LRU. Telegram's `message_id` is just a
// per-chat counter (it starts at small ints and resets per chat), so the same
// numeric id can refer to entirely different messages in two different chats
// the bot is in. Keying on `messageId` alone collides cross-chat — a reaction
// in chat B targeting message #42 would resolve to message #42 from chat A if
// chat A's was cached. Composite `${spaceId}:${messageId}` is unique because
// `spaceId` is `String(chat.id)` (chat ids are globally unique in Telegram).
//
// Both numeric and string forms are accepted because call sites variously hold
// the raw `Update.message_id` (number) or already-stringified ids.
export const messageCacheKey = (
  spaceId: string,
  messageId: number | string
): string => `${spaceId}:${messageId}`;

export interface TelegramCache {
  readonly albumOptions: Pick<
    AlbumBufferOptions,
    "ceilingMs" | "concurrentCapacity" | "debounceMs"
  >;
  readonly coalesceAlbums: boolean;
  destroy(): void;
  readonly messages: TelegramLRU<string, TelegramMessage>;
  readonly polls: PollStore;
}

export const createTelegramCache = (
  options: TelegramCacheOptions
): TelegramCache => {
  const messages = new TelegramLRU<string, TelegramMessage>(
    options.capacity.messages
  );
  const polls = new PollStore(
    options.capacity.polls,
    options.capacity.pollVotes
  );
  return {
    messages,
    polls,
    coalesceAlbums: options.coalesceAlbums,
    albumOptions: {
      concurrentCapacity: options.capacity.albumConcurrent,
      debounceMs: options.albumDebounceMs,
      ceilingMs: options.albumCeilingMs,
    },
    destroy() {
      messages.clear();
      polls.polls.clear();
      polls.votes.clear();
    },
  };
};
