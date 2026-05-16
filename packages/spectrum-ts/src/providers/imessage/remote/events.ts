import type {
  AdvancedIMessage,
  ChatEvent,
  GroupChange,
  GroupEvent,
  MessageEvent,
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

/**
 * Adapt one of advanced-imessage's `TypedEventStream`s into a ManagedStream.
 * The upstream class already implements `AsyncIterable` and `close()`; we
 * just pump values into a `Repeater`-backed `ManagedStream` so it composes
 * with the rest of spectrum-ts's stream plumbing.
 */
const adaptTyped = <T>(source: {
  [Symbol.asyncIterator]: () => AsyncIterator<T>;
  close(): Promise<void>;
}): ManagedStream<T> =>
  stream<T>((emit, end) => {
    const iter = source[Symbol.asyncIterator]();
    const pump = (async () => {
      try {
        let result = await iter.next();
        while (!result.done) {
          await emit(result.value);
          result = await iter.next();
        }
        end();
      } catch (error) {
        end(error);
      }
    })();

    return async () => {
      await source.close().catch(() => undefined);
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
 * Live-only: the worker's existing `messages` stream already drives
 * `events.catchUp(since)` for durable replay of the same underlying log,
 * and these event producers don't promise durability in the spectrum-ts
 * docs yet. A future PR can layer catch-up onto this broadcaster.
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
    adaptTyped<MessageEvent>(client.messages.subscribeEvents()),
    adaptTyped<ChatEvent>(client.chats.subscribeEvents()),
    adaptTyped<GroupEvent>(client.groups.subscribeEvents()),
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
