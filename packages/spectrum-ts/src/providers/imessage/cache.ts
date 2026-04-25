import type { Poll, PollChoice } from "../../content/poll";
import type { IMessageMessage } from "./types";

const DEFAULT_MAX = 1000;

export interface CachedPoll {
  readonly optionsByIdentifier: ReadonlyMap<string, PollChoice>;
  readonly poll: Poll;
}

export interface PollSelectionDelta {
  readonly optionId: string;
  readonly selected: boolean;
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
  private readonly selectionEventTimesByPoll = new Map<
    string,
    Map<string, number>
  >();
  private readonly selectionsByPoll = new Map<
    string,
    Map<string, Set<string>>
  >();

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
        this.selectionEventTimesByPoll.delete(first);
        this.selectionsByPoll.delete(first);
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.selectionEventTimesByPoll.clear();
    this.selectionsByPoll.clear();
  }

  actorSelectionDeltas(
    pollId: string,
    actorId: string,
    optionIds: readonly string[]
  ): PollSelectionDelta[] {
    const previous = this.selectionsByPoll.get(pollId)?.get(actorId);
    if (!previous) {
      return optionIds.map((optionId) => ({ optionId, selected: true }));
    }
    const current = new Set(optionIds);
    const selected = optionIds
      .filter((optionId) => !previous.has(optionId))
      .map((optionId) => ({ optionId, selected: true }));
    const deselected = [...previous]
      .filter((optionId) => !current.has(optionId))
      .map((optionId) => ({ optionId, selected: false }));
    return [...selected, ...deselected];
  }

  clearedActorSelectionDeltas(
    pollId: string,
    actorId: string
  ): PollSelectionDelta[] {
    const previous = this.selectionsByPoll.get(pollId)?.get(actorId);
    if (!previous) {
      return [];
    }
    return [...previous].map((optionId) => ({ optionId, selected: false }));
  }

  actorSelection(pollId: string, actorId: string): string[] | undefined {
    const selection = this.selectionsByPoll.get(pollId)?.get(actorId);
    return selection ? [...selection] : undefined;
  }

  commitActorSelection(
    pollId: string,
    actorId: string,
    optionIds: readonly string[],
    at?: Date
  ): void {
    let selections = this.selectionsByPoll.get(pollId);
    if (!selections) {
      selections = new Map<string, Set<string>>();
      this.selectionsByPoll.set(pollId, selections);
    }
    selections.set(actorId, new Set(optionIds));

    if (!at) {
      return;
    }
    let eventTimes = this.selectionEventTimesByPoll.get(pollId);
    if (!eventTimes) {
      eventTimes = new Map<string, number>();
      this.selectionEventTimesByPoll.set(pollId, eventTimes);
    }
    const eventTime = at.getTime();
    const previousTime = eventTimes.get(actorId);
    if (previousTime === undefined || eventTime >= previousTime) {
      eventTimes.set(actorId, eventTime);
    }
  }

  isStaleActorSelectionEvent(
    pollId: string,
    actorId: string,
    at: Date
  ): boolean {
    const previousTime = this.selectionEventTimesByPoll
      .get(pollId)
      ?.get(actorId);
    return previousTime !== undefined && at.getTime() < previousTime;
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
