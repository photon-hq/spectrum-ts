import type { Poll as SpectrumPoll } from "../../../content/poll";
import type { TelegramMessage } from "../types";

// Capacity-bounded LRU built on `Map`'s insertion-order guarantee:
// delete-and-reinsert on read marks an entry most-recent; over-capacity
// writes evict the oldest key. No TTL — attachment `read()` re-fetches the
// file URL lazily, so the cached values themselves don't expire.
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

// Album members arrive as separate `Update`s sharing a `media_group_id`,
// with no "album finished" signal. Each new member arms a debounce; the
// buffer flushes after `debounceMs` of quiet, or hits `ceilingMs` as a
// hard ceiling. `concurrentCapacity` caps in-flight albums; overflow
// flushes the oldest early.
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

// `setTimeout` silently coerces NaN / negative values into "fire
// immediately", so validate at construction instead of accepting a footgun.
const assertNonNegativeFiniteMs = (
  field: "ceilingMs" | "debounceMs",
  value: number
): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `AlbumBuffer.${field} must be a non-negative finite number; got ${String(value)}`
    );
  }
};

export class AlbumBuffer {
  private readonly inFlight = new Map<string, AlbumBufferEntry>();
  private readonly options: AlbumBufferOptions;

  constructor(options: AlbumBufferOptions) {
    assertNonNegativeFiniteMs("debounceMs", options.debounceMs);
    assertNonNegativeFiniteMs("ceilingMs", options.ceilingMs);
    if (options.ceilingMs < options.debounceMs) {
      throw new RangeError(
        `AlbumBuffer.ceilingMs (${options.ceilingMs}) must be >= debounceMs (${options.debounceMs})`
      );
    }
    if (
      !Number.isInteger(options.concurrentCapacity) ||
      options.concurrentCapacity < DISABLED_CAPACITY
    ) {
      throw new RangeError(
        `AlbumBuffer.concurrentCapacity must be an integer >= ${DISABLED_CAPACITY}; got ${String(options.concurrentCapacity)}`
      );
    }
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

  /** Flush every in-flight buffer; awaited by stream teardown. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.inFlight.keys()].map((key) => this.flush(key)));
  }

  private armDebounce(mediaGroupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flush(mediaGroupId).catch(() => {
        /* errors are logged inside flush() */
      });
    }, this.options.debounceMs);
  }

  private armCeiling(mediaGroupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flush(mediaGroupId).catch(() => {
        /* errors are logged inside flush() */
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
    // Timer-driven flushes have no awaiter — swallow and log rather than
    // raise an unhandled rejection.
    try {
      await this.options.flush(entry.members);
    } catch (err) {
      console.error("Telegram album flush failed:", err);
    }
  }
}

// `poll_id → CachedPoll` is written by outbound `sendPoll`.
// `(poll_id, user_id) → optionIndexes` is the prior vote vector used to
// diff each `poll_answer` into per-option `selected: true / false` events.

export interface CachedPoll {
  /**
   * Chat snapshot — `poll_answer` updates carry no chat info, so we
   * restore it from here when synthesizing per-vote events.
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

// Telegram `message_id` is only unique per-chat, so the cache key must
// include `spaceId` (= `String(chat.id)`) to avoid cross-chat collisions.
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
