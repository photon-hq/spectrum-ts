import QuickLRU from "quick-lru";
import type { Poll as SpectrumPoll } from "../../../content/poll";
import type { TelegramMessage } from "../types";

// Album members arrive as separate `Update`s sharing a `media_group_id`,
// with no "album finished" signal. Each new member arms a debounce; flush
// fires after `debounceMs` of quiet or when `ceilingMs` is reached.
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

  push(mediaGroupId: string, member: TelegramMessage): void {
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

  async flushAll(): Promise<void> {
    await Promise.all([...this.inFlight.keys()].map((key) => this.flush(key)));
  }

  private armDebounce(mediaGroupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flush(mediaGroupId).catch(() => {
        // logged inside flush()
      });
    }, this.options.debounceMs);
  }

  private armCeiling(mediaGroupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flush(mediaGroupId).catch(() => {
        // logged inside flush()
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
    try {
      await this.options.flush(entry.members);
    } catch (err) {
      console.error("Telegram album flush failed:", err);
    }
  }
}

export interface CachedPoll {
  // `poll_answer` updates carry no chat info, so we restore it from here.
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
  readonly polls: QuickLRU<string, CachedPoll>;
  readonly votes: QuickLRU<string, readonly number[]>;

  constructor(pollCapacity: number, voteCapacity: number) {
    this.polls = new QuickLRU({ maxSize: pollCapacity });
    this.votes = new QuickLRU({ maxSize: voteCapacity });
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

// `quick-lru` may hold up to 2× `maxSize` between promotions, so caps below
// are halved relative to the desired hard ceiling (e.g. 2500 → up to 5000).
export const DEFAULT_CACHE_OPTIONS: TelegramCacheOptions = {
  capacity: {
    messages: 2500,
    polls: 250,
    pollVotes: 2500,
    albumConcurrent: 100,
  },
  albumDebounceMs: 500,
  albumCeilingMs: 2000,
  coalesceAlbums: false,
};

// `message_id` is unique per-chat, so the key namespaces by `spaceId`.
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
  readonly messages: QuickLRU<string, TelegramMessage>;
  readonly polls: PollStore;
}

export const createTelegramCache = (
  options: TelegramCacheOptions
): TelegramCache => {
  const messages = new QuickLRU<string, TelegramMessage>({
    maxSize: options.capacity.messages,
  });
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
