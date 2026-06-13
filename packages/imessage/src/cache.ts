import type { Poll, PollChoice } from "@spectrum-ts/core";
import type { IMessageMessage } from "./types";

const DEFAULT_MAX = 1000;

export interface CachedPoll {
  readonly optionsByIdentifier: ReadonlyMap<string, PollChoice>;
  readonly poll: Poll;
}

/**
 * Bounded insertion-order cache of recently-seen iMessage messages, keyed by
 * guid. Provides O(1) lookup for reaction target resolution. When capacity is
 * exceeded, the oldest entry is evicted. Access does not promote recency —
 * this is a bounded FIFO, not an LRU. The workload (reactions arriving shortly
 * after the message they target) doesn't benefit from LRU semantics, and FIFO
 * avoids a dependency.
 */
export class MessageCache {
  private readonly map = new Map<string, IMessageMessage>();
  private readonly max: number;

  constructor(max = DEFAULT_MAX) {
    this.max = max;
  }

  get(id: string): IMessageMessage | undefined {
    return this.map.get(id);
  }

  set(id: string, message: IMessageMessage): void {
    if (this.map.has(id)) {
      this.map.delete(id);
    }
    this.map.set(id, message);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) {
        this.map.delete(first);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Bounded insertion-order cache of recently-seen iMessage polls, keyed by
 * poll message guid. The public poll shape deliberately hides provider ids;
 * `optionsByIdentifier` keeps the private lookup table needed to correlate
 * vote events back to public `PollChoice` objects.
 */
export class PollCache {
  private readonly map = new Map<string, CachedPoll>();
  private readonly max: number;

  constructor(max = DEFAULT_MAX) {
    this.max = max;
  }

  get(id: string): CachedPoll | undefined {
    return this.map.get(id);
  }

  set(id: string, poll: CachedPoll): void {
    if (this.map.has(id)) {
      this.map.delete(id);
    }
    this.map.set(id, poll);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) {
        this.map.delete(first);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

const messageCaches = new WeakMap<object, MessageCache>();
const pollCaches = new WeakMap<object, PollCache>();

/**
 * Returns a per-client message cache. Keyed by an object (the client array
 * for remote, or the IMessageSDK instance for local), so each iMessage
 * provider instance has its own cache and multiple providers don't share
 * state accidentally.
 */
export const getMessageCache = (owner: object): MessageCache => {
  let cache = messageCaches.get(owner);
  if (!cache) {
    cache = new MessageCache();
    messageCaches.set(owner, cache);
  }
  return cache;
};

export const getPollCache = (owner: object): PollCache => {
  let cache = pollCaches.get(owner);
  if (!cache) {
    cache = new PollCache();
    pollCaches.set(owner, cache);
  }
  return cache;
};
