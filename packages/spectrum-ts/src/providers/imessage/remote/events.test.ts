import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AdvancedIMessage,
  AuthenticationError,
  type ChatEvent,
  type GroupEvent,
  IMessageError,
  type MessageEvent,
} from "@photon-ai/advanced-imessage";
import { createStore } from "../../../utils/store";
import type { RemoteClient } from "../types";
import {
  chatReadEvents,
  groupChangeEvents,
  messageEditEvents,
  messageUnsendEvents,
  reactionRemovedEvents,
  readReceiptEvents,
} from "./events";

// Silence `console.warn`/`console.error` during these tests — the
// resume-on-error wrapper logs every reconnect attempt, and our test
// harness intentionally triggers fake "upstream ended" closures to
// terminate fixtures. Tests that *want* to assert on retry behavior
// keep their own counter via the subscribe thunk; logs are noise.
let originalWarn: typeof console.warn;
let originalError: typeof console.error;
beforeEach(() => {
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
});
afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// Fake AdvancedIMessage harness
//
// We mock just the three resources every producer subscribes to:
//   - client.messages.subscribeEvents()
//   - client.chats.subscribeEvents()
//   - client.groups.subscribeEvents()
//
// Each returns a TypedEventStream-shaped object (async iterable + close()).
// Tests push events through a queue and assert that the producer yields
// the expected projected payload.
// ---------------------------------------------------------------------------

interface FakeStream<T> {
  endAll(): void;
  push(value: T): void;
  stream: {
    [Symbol.asyncIterator](): AsyncIterator<T>;
    close(): Promise<void>;
  };
}

const createFakeStream = <T>(): FakeStream<T> => {
  const queue: T[] = [];
  const waiters: ((value: IteratorResult<T>) => void)[] = [];
  let closed = false;

  const next = (): Promise<IteratorResult<T>> => {
    if (queue.length > 0) {
      const value = queue.shift() as T;
      return Promise.resolve({ done: false, value });
    }
    if (closed) {
      return Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      waiters.push(resolve);
    });
  };

  return {
    push(value): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        queue.push(value);
      }
    },
    endAll(): void {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined as never });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return { next };
      },
      close: () => {
        closed = true;
        for (const waiter of waiters.splice(0)) {
          waiter({ done: true, value: undefined as never });
        }
        return Promise.resolve();
      },
    },
  };
};

interface FakeClient {
  chats: FakeStream<ChatEvent>;
  client: AdvancedIMessage;
  groups: FakeStream<GroupEvent>;
  messages: FakeStream<MessageEvent>;
}

const createFakeClient = (): FakeClient => {
  const messages = createFakeStream<MessageEvent>();
  const chats = createFakeStream<ChatEvent>();
  const groups = createFakeStream<GroupEvent>();
  const client = {
    messages: {
      subscribeEvents: () => messages.stream,
    },
    chats: {
      subscribeEvents: () => chats.stream,
    },
    groups: {
      subscribeEvents: () => groups.stream,
    },
  } as unknown as AdvancedIMessage;
  return { chats, client, groups, messages };
};

const oneClient = (fake: FakeClient): RemoteClient[] => [
  { client: fake.client, phone: "+15555550100" },
];

// Pull `n` items off an AsyncIterable, with one global timeout so a hung
// producer fails the test instead of hanging it. The previous version's
// per-call race triggered a subtle bug: a slow `next()` would leak past
// the per-call timer, so a value that arrived after the reconnect delay
// (500ms with jitter) showed up as "no events delivered" to the test.
const collect = async <T>(
  iter: AsyncIterable<T>,
  n: number,
  timeoutMs = 1000
): Promise<T[]> => {
  const items: T[] = [];
  const iterator = iter[Symbol.asyncIterator]();
  let timedOut = false;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });

  while (items.length < n) {
    const race = await Promise.race([
      iterator.next().then((r) => ({ kind: "next" as const, value: r })),
      timeout,
    ]);
    if (race.kind === "timeout" || timedOut) {
      throw new Error(`collect timed out after ${items.length}/${n} items`);
    }
    if (race.value.done) {
      break;
    }
    items.push(race.value.value);
  }
  await iterator.return?.();
  return items;
};

// Event fixtures
const readEvent = (overrides: Partial<MessageEvent> = {}): MessageEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    chatGuid: "any;-;+15550100",
    messageGuid: "guid-1",
    occurredAt: new Date("2026-05-06T12:00:00.000Z"),
    readAt: new Date("2026-05-06T12:01:00.000Z"),
    sequence: 1,
    type: "message.read",
    ...overrides,
  }) as MessageEvent;

const editEvent = (): MessageEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    chatGuid: "any;-;+15550100",
    content: {
      attachments: [],
      formatting: [],
      mentions: [],
      text: "hello, edited",
    },
    editedAt: new Date("2026-05-06T12:02:00.000Z"),
    messageGuid: "guid-1",
    occurredAt: new Date("2026-05-06T12:02:00.000Z"),
    sequence: 2,
    type: "message.edited",
  }) as unknown as MessageEvent;

const unsendEvent = (): MessageEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    chatGuid: "any;-;+15550100",
    messageGuid: "guid-1",
    occurredAt: new Date("2026-05-06T12:03:00.000Z"),
    retractedAt: new Date("2026-05-06T12:03:00.000Z"),
    sequence: 3,
    type: "message.unsent",
  }) as MessageEvent;

const reactionRemovedEvent = (): MessageEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    chatGuid: "any;-;+15550100",
    messageGuid: "guid-1",
    occurredAt: new Date("2026-05-06T12:04:00.000Z"),
    reaction: { kind: "love" },
    sequence: 4,
    targetPartIndex: 0,
    type: "message.reactionRemoved",
  }) as MessageEvent;

const chatMarkedReadEvent = (): ChatEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    chatGuid: "any;-;+15550100",
    occurredAt: new Date("2026-05-06T12:05:00.000Z"),
    sequence: 5,
    type: "chat.markedRead",
  }) as ChatEvent;

const groupNameChangeEvent = (): GroupEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    change: {
      displayName: "new name",
      type: "displayNameChanged",
    },
    chatGuid: "any;+;chat-1",
    occurredAt: new Date("2026-05-06T12:06:00.000Z"),
    sequence: 6,
    type: "group.changed",
  }) as unknown as GroupEvent;

const groupParticipantAddedEvent = (): GroupEvent =>
  ({
    actor: { address: "+15550100", service: "iMessage" },
    change: {
      participant: { address: "+15550200", service: "iMessage" },
      type: "participantAdded",
    },
    chatGuid: "any;+;chat-1",
    occurredAt: new Date("2026-05-06T12:07:00.000Z"),
    sequence: 7,
    type: "group.changed",
  }) as unknown as GroupEvent;

const groupParticipantLeftEvent = (): GroupEvent =>
  ({
    change: {
      participant: { address: "+15550200", service: "iMessage" },
      type: "participantLeft",
    },
    chatGuid: "any;+;chat-1",
    occurredAt: new Date("2026-05-06T12:08:00.000Z"),
    sequence: 8,
    type: "group.changed",
  }) as unknown as GroupEvent;

describe("readReceiptEvents", () => {
  test("yields one ReadReceipt per message.read event", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = readReceiptEvents(oneClient(fake), store);
    fake.messages.push(readEvent());

    const [receipt] = await collect(iter, 1);
    expect(receipt?.messageId).toBe("guid-1");
    expect(receipt?.spaceId).toBe("any;-;+15550100");
    expect(receipt?.readBy.id).toBe("+15550100");
    expect(receipt?.readAt).toEqual(new Date("2026-05-06T12:01:00.000Z"));

    fake.messages.endAll();
  });

  test("ignores other message events", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = readReceiptEvents(oneClient(fake), store);
    fake.messages.push(editEvent());
    fake.messages.push(readEvent());

    const [receipt] = await collect(iter, 1);
    expect(receipt?.messageId).toBe("guid-1");
    expect(receipt?.readAt).toBeDefined();

    fake.messages.endAll();
  });

  test("drops events with no actor address (we'd have nothing to attribute)", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = readReceiptEvents(oneClient(fake), store);
    // No actor — should be skipped
    fake.messages.push(readEvent({ actor: undefined }));
    // Valid follow-up — should reach the consumer
    fake.messages.push(readEvent({ messageGuid: "guid-2" }));

    const [receipt] = await collect(iter, 1);
    expect(receipt?.messageId).toBe("guid-2");

    fake.messages.endAll();
  });
});

describe("chatReadEvents", () => {
  test("yields a ChatRead per chat.markedRead event", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = chatReadEvents(oneClient(fake), store);
    fake.chats.push(chatMarkedReadEvent());

    const [evt] = await collect(iter, 1);
    expect(evt?.spaceId).toBe("any;-;+15550100");
    expect(evt?.readBy.id).toBe("+15550100");
    expect(evt?.readAt).toEqual(new Date("2026-05-06T12:05:00.000Z"));

    fake.chats.endAll();
  });
});

describe("messageEditEvents", () => {
  test("projects new content as spectrum text Content", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = messageEditEvents(oneClient(fake), store);
    fake.messages.push(editEvent());

    const [evt] = await collect(iter, 1);
    expect(evt?.messageId).toBe("guid-1");
    expect(evt?.newContent.type).toBe("text");
    expect((evt?.newContent as { text: string }).text).toBe("hello, edited");
    expect(evt?.editedAt).toEqual(new Date("2026-05-06T12:02:00.000Z"));

    fake.messages.endAll();
  });
});

describe("messageUnsendEvents", () => {
  test("yields the projected unsend payload", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = messageUnsendEvents(oneClient(fake), store);
    fake.messages.push(unsendEvent());

    const [evt] = await collect(iter, 1);
    expect(evt?.messageId).toBe("guid-1");
    expect(evt?.unsentAt).toEqual(new Date("2026-05-06T12:03:00.000Z"));

    fake.messages.endAll();
  });
});

describe("reactionRemovedEvents", () => {
  test("maps tapback kind to the canonical emoji", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = reactionRemovedEvents(oneClient(fake), store);
    fake.messages.push(reactionRemovedEvent());

    const [evt] = await collect(iter, 1);
    expect(evt?.messageId).toBe("guid-1");
    expect(evt?.emoji).toBe("❤️");
    expect(evt?.reactor.id).toBe("+15550100");
    expect(evt?.targetPartIndex).toBe(0);

    fake.messages.endAll();
  });
});

describe("groupChangeEvents", () => {
  test("displayNameChanged → kind=displayNameChanged + newDisplayName", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = groupChangeEvents(oneClient(fake), store);
    fake.groups.push(groupNameChangeEvent());

    const [evt] = await collect(iter, 1);
    expect(evt?.kind).toBe("displayNameChanged");
    if (evt?.kind !== "displayNameChanged") {
      throw new Error("expected displayNameChanged");
    }
    expect(evt.newDisplayName).toBe("new name");
    expect(evt.actor.id).toBe("+15550100");

    fake.groups.endAll();
  });

  test("participantAdded carries actor and participant", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = groupChangeEvents(oneClient(fake), store);
    fake.groups.push(groupParticipantAddedEvent());

    const [evt] = await collect(iter, 1);
    if (evt?.kind !== "participantAdded") {
      throw new Error(`expected participantAdded, got ${evt?.kind}`);
    }
    expect(evt.actor.id).toBe("+15550100");
    expect(evt.participant.id).toBe("+15550200");

    fake.groups.endAll();
  });

  test("participantLeft has participant but no actor (by design)", async () => {
    const fake = createFakeClient();
    const store = createStore();
    const iter = groupChangeEvents(oneClient(fake), store);
    fake.groups.push(groupParticipantLeftEvent());

    const [evt] = await collect(iter, 1);
    if (evt?.kind !== "participantLeft") {
      throw new Error(`expected participantLeft, got ${evt?.kind}`);
    }
    expect(evt.participant.id).toBe("+15550200");
    // @ts-expect-error — participantLeft variant has no `actor`
    expect(evt.actor).toBeUndefined();

    fake.groups.endAll();
  });
});

describe("shared broadcaster", () => {
  test("two producers on the same phone share one upstream subscription", async () => {
    const fake = createFakeClient();
    let subscribeCount = 0;
    const baseStream = fake.messages.stream;
    const wrappedClient = {
      ...fake.client,
      messages: {
        subscribeEvents: () => {
          subscribeCount += 1;
          return baseStream;
        },
      },
    } as unknown as AdvancedIMessage;
    const clients: RemoteClient[] = [
      { client: wrappedClient, phone: "+15555550100" },
    ];
    const store = createStore();

    // Spin up two producers; both should funnel through the single
    // broadcaster created on first subscribe.
    const reads = readReceiptEvents(clients, store);
    const edits = messageEditEvents(clients, store);

    // Touch both — start iterating so the broadcaster's pump kicks in.
    const readIter = reads[Symbol.asyncIterator]();
    const editIter = edits[Symbol.asyncIterator]();
    const readNext = readIter.next();
    const editNext = editIter.next();

    fake.messages.push(readEvent());
    fake.messages.push(editEvent());

    const readResult = await Promise.race([
      readNext,
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 100)
      ),
    ]);
    const editResult = await Promise.race([
      editNext,
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 100)
      ),
    ]);
    expect(readResult.done).toBe(false);
    expect(editResult.done).toBe(false);
    expect(subscribeCount).toBe(1);

    await readIter.return?.();
    await editIter.return?.();
    fake.messages.endAll();
  });
});

describe("local-mode bypass (provider-level)", () => {
  test("each producer wrapped via remoteOnlyEvent yields nothing for local clients", async () => {
    // This is exercised at the provider definition site (`imessage/index.ts`).
    // Here we sanity-check that calling the remote producers with an empty
    // client array also yields nothing — that's the surface the local
    // bypass relies on staying inert.
    const store = createStore();
    const iter = readReceiptEvents([], store);
    const result = await Promise.race([
      iter[Symbol.asyncIterator]().next(),
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 50)
      ),
    ]);
    expect(result.done).toBe(true);
  });
});

describe("resume-on-error", () => {
  test("reconnects after a transient upstream error and keeps delivering", async () => {
    // First subscribe yields an IMessageError on first next(); second
    // subscribe yields a valid event. The producer must reconnect and
    // deliver the event from the second subscription.
    const phone = "+15555550199";
    let subscribeCount = 0;
    const events: MessageEvent[] = [readEvent({ messageGuid: "after-retry" })];

    const subscribe = (): {
      [Symbol.asyncIterator](): AsyncIterator<MessageEvent>;
      close(): Promise<void>;
    } => {
      subscribeCount += 1;
      const callCount = subscribeCount;
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<MessageEvent>> {
              if (callCount === 1) {
                return Promise.reject(
                  new IMessageError("transient gRPC blip", {
                    code: "UNAVAILABLE" as never,
                    grpcCode: 14,
                    retryable: true,
                  })
                );
              }
              const value = events.shift();
              if (value) {
                return Promise.resolve({ done: false, value });
              }
              return new Promise<IteratorResult<MessageEvent>>(() => undefined);
            },
          };
        },
        close: () => Promise.resolve(),
      };
    };

    const fakeClient = {
      chats: { subscribeEvents: () => createFakeStream<ChatEvent>().stream },
      groups: { subscribeEvents: () => createFakeStream<GroupEvent>().stream },
      messages: { subscribeEvents: subscribe },
    } as unknown as AdvancedIMessage;
    const clients: RemoteClient[] = [{ client: fakeClient, phone }];
    const store = createStore();

    const iter = readReceiptEvents(clients, store);
    const [receipt] = await collect(iter, 1, 3000);
    expect(receipt?.messageId).toBe("after-retry");
    expect(subscribeCount).toBeGreaterThanOrEqual(2);
  });

  test("stops permanently on a non-retryable upstream error (AuthenticationError)", async () => {
    const phone = "+15555550299";
    let subscribeCount = 0;
    const subscribe = (): {
      [Symbol.asyncIterator](): AsyncIterator<MessageEvent>;
      close(): Promise<void>;
    } => {
      subscribeCount += 1;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              Promise.reject(
                new AuthenticationError("bad token", {
                  code: "UNAUTHENTICATED" as never,
                  grpcCode: 16,
                  retryable: false,
                })
              ),
          };
        },
        close: () => Promise.resolve(),
      };
    };

    const fakeClient = {
      chats: { subscribeEvents: () => createFakeStream<ChatEvent>().stream },
      groups: { subscribeEvents: () => createFakeStream<GroupEvent>().stream },
      messages: { subscribeEvents: subscribe },
    } as unknown as AdvancedIMessage;
    const clients: RemoteClient[] = [{ client: fakeClient, phone }];
    const store = createStore();

    const iter = readReceiptEvents(clients, store);
    // Pull next() once — should reject (non-retryable propagates) OR finish
    // (done: true after error end). Either way, no retry storm.
    const iterator = iter[Symbol.asyncIterator]();
    const result = await Promise.race([
      iterator
        .next()
        .then((r) => ({ kind: "result" as const, value: r }))
        .catch((error) => ({ error, kind: "error" as const })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 500)
      ),
    ]);
    // Either an error bubbled or the stream terminated; what must NOT happen
    // is unbounded retries (timeout).
    expect(result.kind).not.toBe("timeout");
    // Exactly one subscribe attempt — no reconnect after AuthenticationError.
    expect(subscribeCount).toBe(1);
    await iterator.return?.();
  });

  test("a clean upstream end is treated as retryable (reconnect, not terminate)", async () => {
    // The upstream `TypedEventStream` can iterate to completion if the
    // server closes the gRPC stream cleanly. We should NOT permanently
    // shut down the broadcaster on that — reconnect.
    const phone = "+15555550399";
    let subscribeCount = 0;
    const subscribe = (): {
      [Symbol.asyncIterator](): AsyncIterator<MessageEvent>;
      close(): Promise<void>;
    } => {
      subscribeCount += 1;
      const callCount = subscribeCount;
      return {
        [Symbol.asyncIterator]() {
          let yielded = false;
          return {
            next(): Promise<IteratorResult<MessageEvent>> {
              if (callCount === 1) {
                // Immediately end the first subscription.
                return Promise.resolve({
                  done: true,
                  value: undefined as never,
                });
              }
              if (yielded) {
                return new Promise<IteratorResult<MessageEvent>>(
                  () => undefined
                );
              }
              yielded = true;
              return Promise.resolve({
                done: false,
                value: readEvent({ messageGuid: "after-clean-end" }),
              });
            },
          };
        },
        close: () => Promise.resolve(),
      };
    };

    const fakeClient = {
      chats: { subscribeEvents: () => createFakeStream<ChatEvent>().stream },
      groups: { subscribeEvents: () => createFakeStream<GroupEvent>().stream },
      messages: { subscribeEvents: subscribe },
    } as unknown as AdvancedIMessage;
    const clients: RemoteClient[] = [{ client: fakeClient, phone }];
    const store = createStore();

    const iter = readReceiptEvents(clients, store);
    const [receipt] = await collect(iter, 1, 3000);
    expect(receipt?.messageId).toBe("after-clean-end");
    expect(subscribeCount).toBeGreaterThanOrEqual(2);
  });
});
