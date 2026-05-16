import {
  type AdvancedIMessage,
  AuthenticationError,
  type ChatEvent,
  type GroupChange,
  type GroupEvent,
  IMessageError,
  type MessageEvent,
  NotFoundError,
  ValidationError,
} from "@photon-ai/advanced-imessage";
import { asCustom } from "../../../content/custom";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import type { Store } from "../../../utils/store";
import {
  type Broadcaster,
  broadcast,
  type ManagedStream,
  stream,
} from "../../../utils/stream";
import type { RemoteClient } from "../types";

// Lightweight logger that mirrors `console.warn` from `inbound.ts`. Using
// `@photon-ai/otel`'s `createLogger` would be more uniform, but it's not
// in the workspace's test runtime; reconnect telemetry will be picked
// up via these stderr lines until otel-everywhere lands.
const warn = (message: string, fields: Record<string, unknown>): void => {
  console.warn(`[spectrum-ts][imessage.events] ${message}`, fields);
};
const errorLog = (message: string, fields: Record<string, unknown>): void => {
  console.error(`[spectrum-ts][imessage.events] ${message}`, fields);
};

// ---------------------------------------------------------------------------
// Public event payload shapes — what spectrum-ts emits on each stream
// ---------------------------------------------------------------------------

interface UserRef {
  id: string;
}

export interface ReadReceipt {
  messageId: string;
  readAt: Date;
  readBy: UserRef;
  spaceId: string;
}

export interface ChatRead {
  readAt: Date;
  readBy: UserRef;
  spaceId: string;
}

export interface MessageEdit {
  editedAt: Date;
  messageId: string;
  newContent: Content;
  spaceId: string;
}

export interface MessageUnsend {
  messageId: string;
  spaceId: string;
  unsentAt: Date;
}

export interface ReactionRemoved {
  emoji: string;
  messageId: string;
  reactor: UserRef;
  removedAt: Date;
  spaceId: string;
  targetPartIndex?: number;
}

export type GroupChangeEvent =
  | {
      kind: "displayNameChanged";
      spaceId: string;
      newDisplayName: string;
      actor: UserRef;
      at: Date;
    }
  | {
      kind: "participantAdded";
      spaceId: string;
      participant: UserRef;
      actor: UserRef;
      at: Date;
    }
  | {
      kind: "participantRemoved";
      spaceId: string;
      participant: UserRef;
      actor: UserRef;
      at: Date;
    }
  | {
      kind: "participantLeft";
      spaceId: string;
      participant: UserRef;
      at: Date;
    }
  | { kind: "iconChanged"; spaceId: string; actor: UserRef; at: Date }
  | { kind: "iconRemoved"; spaceId: string; actor: UserRef; at: Date };

// ---------------------------------------------------------------------------
// Tapback emoji mapping (mirrors `remote/reactions.ts`)
// ---------------------------------------------------------------------------

const TAPBACK_TO_EMOJI: Readonly<Record<string, string>> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

const reactionToEmoji = (reaction: {
  kind: string;
  emoji?: string;
}): string | undefined =>
  reaction.kind === "emoji" ? reaction.emoji : TAPBACK_TO_EMOJI[reaction.kind];

// ---------------------------------------------------------------------------
// Shared per-phone broadcaster
// ---------------------------------------------------------------------------

type AnyEvent = MessageEvent | ChatEvent | GroupEvent;

const broadcasterStoreKey = (phone: string): string =>
  `imessage:eventBroadcast:${phone}`;

interface LiveSource<T> extends AsyncIterable<T> {
  close(): Promise<void>;
}

/**
 * Mirror the retry classification used by the messages stream
 * (`remote/stream.ts:isRetryableIMessageStreamError`). Auth, NotFound, and
 * Validation are configuration / contract bugs and don't heal on retry;
 * everything else (transient gRPC errors, server restarts, connection
 * resets, plain stream-ended-prematurely) is worth backing off and
 * reconnecting on.
 */
const isRetryableUpstreamError = (error: unknown): boolean => {
  if (
    error instanceof AuthenticationError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError
  ) {
    return false;
  }
  if (error instanceof IMessageError) {
    return true;
  }
  // Non-IMessageError errors (network, generic Error, "stream ended
  // unexpectedly") are also retryable — they typically indicate a
  // transient disconnect.
  return true;
};

const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_RESET_AFTER_MS = 30_000;

const jitter = (delayMs: number): number => Math.random() * delayMs;

/**
 * Subscribe to a live `TypedEventStream`-shaped upstream and yield its
 * events into a `ManagedStream`, reconnecting with exponential backoff on
 * transient errors. Without this wrapper, a single gRPC hiccup would
 * permanently kill every consumer of the broadcaster until the worker
 * restarts — see comment in `getEventBroadcaster` for the broader
 * lifecycle.
 *
 * Live-only by design: no cursor or catch-up. Events delivered while the
 * stream is reconnecting are lost. Use `client.events.catchUp(since)`
 * via the messages stream for durable replay; this wrapper exists so
 * a transient blip doesn't take readReceipt / chatRead / etc. offline.
 */
interface ResumeState<T> {
  activeSource: LiveSource<T> | undefined;
  closed: boolean;
  delayMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  resetAfterMs: number;
  sleepTimer: ReturnType<typeof setTimeout> | undefined;
  wakeSleep: (() => void) | undefined;
}

const cancelSleep = <T>(state: ResumeState<T>): void => {
  if (state.sleepTimer) {
    clearTimeout(state.sleepTimer);
    state.sleepTimer = undefined;
  }
  state.wakeSleep?.();
  state.wakeSleep = undefined;
};

const sleepWithCancel = <T>(
  state: ResumeState<T>,
  ms: number
): Promise<void> => {
  if (ms <= 0 || state.closed) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    state.wakeSleep = resolve;
    state.sleepTimer = setTimeout(resolve, jitter(ms));
  }).then(() => {
    state.sleepTimer = undefined;
    state.wakeSleep = undefined;
  });
};

const nextBackoffDelay = <T>(state: ResumeState<T>): number => {
  const current = state.delayMs;
  state.delayMs = Math.min(state.delayMs * 2, state.maxDelayMs);
  return current;
};

const consumeOnce = async <T>(
  state: ResumeState<T>,
  subscribe: () => LiveSource<T>,
  label: string,
  emit: (value: T) => Promise<void>
): Promise<void> => {
  const source = subscribe();
  state.activeSource = source;
  const connectedAt = Date.now();
  try {
    for await (const value of source) {
      if (state.closed) {
        return;
      }
      // If we've been delivering successfully past the reset window,
      // forget the prior backoff so the next disconnect retries fast.
      if (Date.now() - connectedAt >= state.resetAfterMs) {
        state.delayMs = state.initialDelayMs;
      }
      await emit(value);
    }
    // Source ended cleanly — treat like a retryable disconnect so we
    // reconnect rather than terminating the whole broadcaster.
    throw new Error(`upstream ${label} ended; reconnecting`);
  } finally {
    if (state.activeSource === source) {
      state.activeSource = undefined;
    }
    await source.close().catch(() => undefined);
  }
};

const handleConsumeError = <T>(
  state: ResumeState<T>,
  error: unknown,
  label: string,
  end: (error?: unknown) => void
): number | undefined => {
  if (state.closed) {
    return;
  }
  if (!isRetryableUpstreamError(error)) {
    errorLog("upstream errored fatally; ending stream", {
      error: error instanceof Error ? error.message : String(error),
      label,
    });
    end(error);
    return;
  }
  const wait = nextBackoffDelay(state);
  warn("upstream errored; reconnecting", {
    delayMs: wait,
    error: error instanceof Error ? error.message : String(error),
    label,
  });
  return wait;
};

const resumableLiveStream = <T>(
  subscribe: () => LiveSource<T>,
  label: string,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    /** Time of stable delivery after which the backoff resets to initial. */
    resetAfterMs?: number;
  } = {}
): ManagedStream<T> =>
  stream<T>((emit, end) => {
    const state: ResumeState<T> = {
      activeSource: undefined,
      closed: false,
      delayMs: options.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS,
      initialDelayMs: options.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS,
      resetAfterMs: options.resetAfterMs ?? RECONNECT_RESET_AFTER_MS,
      sleepTimer: undefined,
      wakeSleep: undefined,
    };

    const run = async () => {
      while (!state.closed) {
        try {
          await consumeOnce(state, subscribe, label, emit);
        } catch (error) {
          const wait = handleConsumeError(state, error, label, end);
          if (wait === undefined) {
            return;
          }
          await sleepWithCancel(state, wait);
        }
      }
    };

    const pump = run();

    return async () => {
      state.closed = true;
      cancelSleep(state);
      await state.activeSource?.close().catch(() => undefined);
      await pump.catch(() => undefined);
    };
  });

/**
 * Merge multiple ManagedStreams of heterogeneous-but-related event types
 * into a single ManagedStream of their union. `mergeStreams` requires the
 * same element type across all inputs; this thin wrapper lets us union
 * `MessageEvent`, `ChatEvent`, and `GroupEvent` without a structural cast
 * dance at every callsite.
 */
const mergeUnion = (
  sources: ManagedStream<AnyEvent>[]
): ManagedStream<AnyEvent> =>
  stream<AnyEvent>((emit, end) => {
    if (sources.length === 0) {
      end();
      return;
    }
    let open = sources.length;
    const workers = sources.map(async (source) => {
      try {
        for await (const value of source) {
          await emit(value);
        }
      } catch (error) {
        end(error);
      } finally {
        open -= 1;
        if (open === 0) {
          end();
        }
      }
    });

    return async () => {
      await Promise.allSettled(sources.map((s) => s.close()));
      await Promise.allSettled(workers).catch(() => undefined);
    };
  });

/**
 * Per-phone broadcaster across every event family this provider exposes
 * beyond the core `messages` stream. Lazily constructed on first subscribe
 * and stashed in `store` so every custom-event producer (`readReceipt`,
 * `chatRead`, …) shares one upstream subscription instead of opening six.
 *
 * Each upstream subscription is wrapped in `resumableLiveStream` so a
 * transient gRPC error or server restart doesn't take the broadcaster
 * permanently offline. Catch-up replay across the disconnect window is
 * NOT performed — events delivered while reconnecting are dropped. The
 * existing `messages` stream still drives `events.catchUp(since)` for
 * durable replay of the same underlying log; a future PR can layer
 * catch-up onto this broadcaster.
 */
const getEventBroadcaster = (
  store: Store,
  client: AdvancedIMessage,
  phone: string
): Broadcaster<AnyEvent> => {
  const key = broadcasterStoreKey(phone);
  const existing = store.get(key) as Broadcaster<AnyEvent> | undefined;
  if (existing) {
    return existing;
  }
  const merged = mergeUnion([
    resumableLiveStream<MessageEvent>(
      () => client.messages.subscribeEvents(),
      `messages:${phone}`
    ),
    resumableLiveStream<ChatEvent>(
      () => client.chats.subscribeEvents(),
      `chats:${phone}`
    ),
    resumableLiveStream<GroupEvent>(
      () => client.groups.subscribeEvents(),
      `groups:${phone}`
    ),
  ]);
  const broadcaster = broadcast(merged);
  store.set(key, broadcaster);
  return broadcaster;
};

/**
 * Build a per-producer stream for a single remote client.
 *
 * `filterAndProject` returns the public payload for events it handles, or
 * `undefined` to skip an upstream event that doesn't belong to this
 * producer's family.
 */
const projectEvents = <T>(
  source: ManagedStream<AnyEvent>,
  filterAndProject: (event: AnyEvent) => T | undefined
): ManagedStream<T> =>
  stream<T>((emit, end) => {
    const pump = (async () => {
      try {
        for await (const event of source) {
          const projected = filterAndProject(event);
          if (projected !== undefined) {
            await emit(projected);
          }
        }
        end();
      } catch (error) {
        end(error);
      }
    })();

    return async () => {
      await source.close();
      await pump.catch(() => undefined);
    };
  });

/**
 * Merge a per-producer stream across every phone the iMessage config
 * exposes. Each phone has its own shared broadcaster; one subscriber per
 * phone is enough to reach every event family there.
 */
const perPhoneStream = <T>(
  clients: RemoteClient[],
  store: Store,
  filterAndProject: (event: AnyEvent) => T | undefined
): ManagedStream<T> => {
  const sources = clients.map((entry) =>
    projectEvents(
      getEventBroadcaster(store, entry.client, entry.phone).subscribe(),
      filterAndProject
    )
  );
  return stream<T>((emit, end) => {
    if (sources.length === 0) {
      end();
      return;
    }
    let open = sources.length;
    const workers = sources.map(async (source) => {
      try {
        for await (const value of source) {
          await emit(value);
        }
      } catch (error) {
        end(error);
      } finally {
        open -= 1;
        if (open === 0) {
          end();
        }
      }
    });
    return async () => {
      await Promise.allSettled(sources.map((s) => s.close()));
      await Promise.allSettled(workers).catch(() => undefined);
    };
  });
};

// ---------------------------------------------------------------------------
// Per-event projections
// ---------------------------------------------------------------------------

const projectReadReceipt = (event: AnyEvent): ReadReceipt | undefined => {
  if (event.type !== "message.read") {
    return;
  }
  const address = event.actor?.address;
  if (!address) {
    return;
  }
  return {
    messageId: event.messageGuid,
    readAt: event.readAt,
    readBy: { id: address },
    spaceId: event.chatGuid,
  };
};

const projectChatRead = (event: AnyEvent): ChatRead | undefined => {
  if (event.type !== "chat.markedRead") {
    return;
  }
  const address = event.actor?.address;
  if (!address) {
    return;
  }
  return {
    readAt: event.occurredAt,
    readBy: { id: address },
    spaceId: event.chatGuid,
  };
};

const projectMessageEdit = (event: AnyEvent): MessageEdit | undefined => {
  if (event.type !== "message.edited") {
    return;
  }
  // Edits only support text content on iMessage (see `handleEdit` in
  // `imessage/index.ts`). When `event.content.text` is present we project
  // to spectrum's text content; if not, we fall back to `asCustom` so the
  // consumer still sees something rather than a silently-dropped event.
  const text = event.content.text;
  const newContent: Content = text ? asText(text) : asCustom(event.content);
  return {
    editedAt: event.editedAt,
    messageId: event.messageGuid,
    newContent,
    spaceId: event.chatGuid,
  };
};

const projectMessageUnsend = (event: AnyEvent): MessageUnsend | undefined => {
  if (event.type !== "message.unsent") {
    return;
  }
  return {
    messageId: event.messageGuid,
    spaceId: event.chatGuid,
    unsentAt: event.retractedAt,
  };
};

const projectReactionRemoved = (
  event: AnyEvent
): ReactionRemoved | undefined => {
  if (event.type !== "message.reactionRemoved") {
    return;
  }
  const address = event.actor?.address;
  if (!address) {
    return;
  }
  const emoji = reactionToEmoji(event.reaction);
  if (!emoji) {
    return;
  }
  const result: ReactionRemoved = {
    emoji,
    messageId: event.messageGuid,
    reactor: { id: address },
    removedAt: event.occurredAt,
    spaceId: event.chatGuid,
  };
  if (typeof event.targetPartIndex === "number") {
    result.targetPartIndex = event.targetPartIndex;
  }
  return result;
};

const projectGroupChange = (
  change: GroupChange,
  spaceId: string,
  actor: string | undefined,
  at: Date
): GroupChangeEvent | undefined => {
  switch (change.type) {
    case "displayNameChanged":
      if (!actor) {
        return;
      }
      return {
        actor: { id: actor },
        at,
        kind: "displayNameChanged",
        newDisplayName: change.displayName,
        spaceId,
      };
    case "participantAdded":
      if (!actor) {
        return;
      }
      return {
        actor: { id: actor },
        at,
        kind: "participantAdded",
        participant: { id: change.participant.address },
        spaceId,
      };
    case "participantRemoved":
      if (!actor) {
        return;
      }
      return {
        actor: { id: actor },
        at,
        kind: "participantRemoved",
        participant: { id: change.participant.address },
        spaceId,
      };
    case "participantLeft":
      return {
        at,
        kind: "participantLeft",
        participant: { id: change.participant.address },
        spaceId,
      };
    case "iconChanged":
      if (!actor) {
        return;
      }
      return { actor: { id: actor }, at, kind: "iconChanged", spaceId };
    case "iconRemoved":
      if (!actor) {
        return;
      }
      return { actor: { id: actor }, at, kind: "iconRemoved", spaceId };
    default:
      return;
  }
};

const projectGroupChangeEvent = (
  event: AnyEvent
): GroupChangeEvent | undefined => {
  if (event.type !== "group.changed") {
    return;
  }
  return projectGroupChange(
    event.change,
    event.chatGuid,
    event.actor?.address,
    event.occurredAt
  );
};

// ---------------------------------------------------------------------------
// Public producers
// ---------------------------------------------------------------------------

export const readReceiptEvents = (
  clients: RemoteClient[],
  store: Store
): AsyncIterable<ReadReceipt> =>
  perPhoneStream(clients, store, projectReadReceipt);

export const chatReadEvents = (
  clients: RemoteClient[],
  store: Store
): AsyncIterable<ChatRead> => perPhoneStream(clients, store, projectChatRead);

export const messageEditEvents = (
  clients: RemoteClient[],
  store: Store
): AsyncIterable<MessageEdit> =>
  perPhoneStream(clients, store, projectMessageEdit);

export const messageUnsendEvents = (
  clients: RemoteClient[],
  store: Store
): AsyncIterable<MessageUnsend> =>
  perPhoneStream(clients, store, projectMessageUnsend);

export const reactionRemovedEvents = (
  clients: RemoteClient[],
  store: Store
): AsyncIterable<ReactionRemoved> =>
  perPhoneStream(clients, store, projectReactionRemoved);

export const groupChangeEvents = (
  clients: RemoteClient[],
  store: Store
): AsyncIterable<GroupChangeEvent> =>
  perPhoneStream(clients, store, projectGroupChangeEvent);
