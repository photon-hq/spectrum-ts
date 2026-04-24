import type { IMessageMessage } from "./types";

const DEFAULT_MAX = 1000;

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

const caches = new WeakMap<object, MessageCache>();

/**
 * Returns a per-client message cache. Keyed by an object (the client array
 * for remote, or the IMessageSDK instance for local), so each iMessage
 * provider instance has its own cache and multiple providers don't share
 * state accidentally.
 */
export const getMessageCache = (owner: object): MessageCache => {
  let cache = caches.get(owner);
  if (!cache) {
    cache = new MessageCache();
    caches.set(owner, cache);
  }
  return cache;
};
