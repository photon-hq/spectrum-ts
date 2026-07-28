import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { flush, settleSoon } from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
import type { ProfileSyncGate } from "@/remote/profile-sync-gate";
import { messages } from "@/remote/stream";
import { type RemoteClient, SHARED_PHONE } from "@/types";

const idleEventStream = () => {
  let closed = false;
  let resolveNext:
    | ((result: IteratorResult<never, undefined>) => void)
    | undefined;

  const close = (): Promise<void> => {
    closed = true;
    resolveNext?.({ done: true, value: undefined });
    resolveNext = undefined;
    return Promise.resolve();
  };

  return {
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<never, undefined>> {
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<never, undefined>> {
          return close().then(() => ({ done: true, value: undefined }));
        },
      };
    },
  };
};

const pushEventStream = <T>() => {
  let closed = false;
  const queued: T[] = [];
  const waiters: ((result: IteratorResult<T, undefined>) => void)[] = [];

  const close = (): Promise<void> => {
    closed = true;
    for (const resolve of waiters.splice(0)) {
      resolve({ done: true, value: undefined });
    }
    return Promise.resolve();
  };

  const stream = {
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          const value = queued.shift();
          if (value !== undefined) {
            return Promise.resolve({ done: false, value });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<T, undefined>> {
          return close().then(() => ({ done: true, value: undefined }));
        },
      };
    },
  };

  return {
    push(value: T): void {
      const resolve = waiters.shift();
      if (resolve) {
        resolve({ done: false, value });
      } else {
        queued.push(value);
      }
    },
    stream,
  };
};

const inboundEvent = (sequence: number, chatGuid: string) => ({
  type: "message.received",
  sequence,
  chatGuid,
  isFromMe: false,
  occurredAt: new Date(1_700_000_000_000 + sequence),
  message: {
    guid: `msg-${sequence}`,
    chatGuids: [chatGuid],
    content: { attachments: [], formatting: [], mentions: [], text: "hi" },
    dateCreated: new Date(1_700_000_000_000 + sequence),
    isFromMe: false,
    sender: { address: "+15550111" },
  },
});

const READ_DATE = new Date(1_700_000_600_000);

const readEvent = (
  sequence: number,
  chatGuid: string,
  actorAddress: string,
  messageGuid = "msg-out"
) => ({
  type: "message.read",
  sequence,
  chatGuid,
  // Deliberately `true`: for a genuine receipt the underlying message is ours.
  // Nothing may key self-suppression off this flag.
  isFromMe: true,
  actor: { address: actorAddress },
  occurredAt: new Date(1_700_000_000_000 + sequence),
  messageGuid,
  readAt: READ_DATE,
});

// Delivers a finite list of events, then idles so the stream stays open.
const finiteEventStream = (events: unknown[]) => {
  let index = 0;
  const idle = idleEventStream();
  return {
    close: idle.close,
    [Symbol.asyncIterator]() {
      const idleIterator = idle[Symbol.asyncIterator]();
      return {
        next(): Promise<IteratorResult<unknown, undefined>> {
          if (index < events.length) {
            const value = events[index];
            index += 1;
            return Promise.resolve({ done: false, value });
          }
          return idleIterator.next();
        },
        return(): Promise<IteratorResult<unknown, undefined>> {
          return idleIterator.return();
        },
      };
    },
  };
};

// An outbound message of ours, as `messages.get` returns it.
const sentMessage = (guid: string) => ({
  guid,
  chatGuids: ["s1"],
  content: { attachments: [], formatting: [], mentions: [], text: "from us" },
  dateCreated: new Date(1_700_000_000_000),
  isFromMe: true,
  sender: { address: "+15550100" },
});

const readReceiptClient = (phone: string, events: unknown[]) => {
  const get = vi.fn((_message: string) =>
    Promise.resolve(sentMessage("msg-out"))
  );
  const entry: RemoteClient = {
    phone,
    client: {
      messages: {
        get,
        subscribeEvents: () => finiteEventStream(events),
      },
      polls: { subscribeEvents: idleEventStream },
      groups: { subscribeEvents: idleEventStream },
    } as unknown as AdvancedIMessage,
  };
  return { entry, get };
};

const remoteClient = (phone: string) => {
  const subscribeToMessages = vi.fn(idleEventStream);
  const subscribeToPolls = vi.fn(idleEventStream);
  const subscribeToGroups = vi.fn(idleEventStream);
  const entry: RemoteClient = {
    phone,
    client: {
      groups: { subscribeEvents: subscribeToGroups },
      messages: { subscribeEvents: subscribeToMessages },
      polls: { subscribeEvents: subscribeToPolls },
    } as unknown as AdvancedIMessage,
  };

  return {
    entry,
    subscribeToGroups,
    subscribeToMessages,
    subscribeToPolls,
  };
};

const startAndClose = async (clients: RemoteClient[]): Promise<void> => {
  const stream = messages(clients);
  const pendingMessage = stream[Symbol.asyncIterator]().next();
  await flush();
  await stream.close();
  await settleSoon(pendingMessage);
};

describe("remote iMessage streams", () => {
  it("does not subscribe to group events in shared mode", async () => {
    const shared = remoteClient(SHARED_PHONE);

    await startAndClose([shared.entry]);

    expect(shared.subscribeToMessages).toHaveBeenCalledTimes(1);
    expect(shared.subscribeToPolls).toHaveBeenCalledTimes(1);
    expect(shared.subscribeToGroups).not.toHaveBeenCalled();
  });

  it("subscribes to group events for a dedicated line", async () => {
    const dedicated = remoteClient("+15550100");

    await startAndClose([dedicated.entry]);

    expect(dedicated.subscribeToMessages).toHaveBeenCalledTimes(1);
    expect(dedicated.subscribeToPolls).toHaveBeenCalledTimes(1);
    expect(dedicated.subscribeToGroups).toHaveBeenCalledTimes(1);
  });

  it("checks the dynamic gate only after the existing chat dedupe", async () => {
    const events = pushEventStream<ReturnType<typeof inboundEvent>>();
    const shareContactInfo = vi.fn((_: string) => Promise.resolve());
    const gate: ProfileSyncGate = {
      dispose: vi.fn(),
      isEnabled: vi.fn(() => Promise.resolve(true)),
    };
    const entry: RemoteClient = {
      phone: "+15550100",
      client: {
        chats: { shareContactInfo },
        groups: { subscribeEvents: idleEventStream },
        messages: { subscribeEvents: () => events.stream },
        polls: { subscribeEvents: idleEventStream },
      } as unknown as AdvancedIMessage,
    };
    const stream = messages([entry], undefined, gate);
    const iterator = stream[Symbol.asyncIterator]();

    const firstPending = iterator.next();
    events.push(inboundEvent(1, "chat-A"));
    await firstPending;
    await vi.waitFor(() => {
      expect(shareContactInfo).toHaveBeenCalledTimes(1);
    });
    expect(gate.isEnabled).toHaveBeenCalledTimes(1);

    const duplicatePending = iterator.next();
    events.push(inboundEvent(2, "chat-A"));
    await duplicatePending;
    await flush();
    expect(gate.isEnabled).toHaveBeenCalledTimes(1);
    expect(shareContactInfo).toHaveBeenCalledTimes(1);

    const secondChatPending = iterator.next();
    events.push(inboundEvent(3, "chat-B"));
    await secondChatPending;
    await vi.waitFor(() => {
      expect(shareContactInfo).toHaveBeenCalledTimes(2);
    });
    expect(gate.isEnabled).toHaveBeenCalledTimes(2);

    await stream.close();
    await settleSoon(iterator.next());
  });

  it("does not consume the chat dedupe while the dynamic gate is false", async () => {
    const events = pushEventStream<ReturnType<typeof inboundEvent>>();
    const shareContactInfo = vi.fn((_: string) => Promise.resolve());
    const isEnabled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const gate: ProfileSyncGate = {
      dispose: vi.fn(),
      isEnabled,
    };
    const entry: RemoteClient = {
      phone: "+15550100",
      client: {
        chats: { shareContactInfo },
        groups: { subscribeEvents: idleEventStream },
        messages: { subscribeEvents: () => events.stream },
        polls: { subscribeEvents: idleEventStream },
      } as unknown as AdvancedIMessage,
    };
    const stream = messages([entry], undefined, gate);
    const iterator = stream[Symbol.asyncIterator]();

    const blockedPending = iterator.next();
    events.push(inboundEvent(1, "chat-A"));
    await blockedPending;
    await flush();
    expect(shareContactInfo).not.toHaveBeenCalled();

    const enabledPending = iterator.next();
    events.push(inboundEvent(2, "chat-A"));
    await enabledPending;
    await vi.waitFor(() => {
      expect(shareContactInfo).toHaveBeenCalledTimes(1);
    });
    expect(isEnabled).toHaveBeenCalledTimes(2);

    await stream.close();
    await settleSoon(iterator.next());
  });

  it("skips an unmappable event instead of wedging the stream", async () => {
    // A deterministic mapping throw must not loop catch-up on the poison
    // event forever — the event after it must still be delivered.
    const poison = { type: "message.received", sequence: 1 };
    const valid = {
      type: "message.received",
      sequence: 2,
      chatGuid: "s1",
      isFromMe: false,
      occurredAt: new Date(1_700_000_000_000),
      message: {
        guid: "msg-ok",
        chatGuids: ["s1"],
        content: { attachments: [], formatting: [], mentions: [], text: "hi" },
        dateCreated: new Date(1_700_000_000_000),
        isFromMe: false,
        sender: { address: "+15550111" },
      },
    };

    const eventStream = (events: unknown[]) => {
      let index = 0;
      const idle = idleEventStream();
      return {
        close: idle.close,
        [Symbol.asyncIterator]() {
          const idleIterator = idle[Symbol.asyncIterator]();
          return {
            next(): Promise<IteratorResult<unknown, undefined>> {
              if (index < events.length) {
                const value = events[index];
                index += 1;
                return Promise.resolve({ done: false, value });
              }
              return idleIterator.next();
            },
            return(): Promise<IteratorResult<unknown, undefined>> {
              return idleIterator.return();
            },
          };
        },
      };
    };

    const entry: RemoteClient = {
      phone: SHARED_PHONE,
      client: {
        messages: {
          subscribeEvents: () => eventStream([poison, valid]),
        },
        polls: { subscribeEvents: idleEventStream },
      } as unknown as AdvancedIMessage,
    };

    const stream = messages([entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value?.id).toBe("msg-ok");
    expect(first.value?.content).toMatchObject({ type: "text", text: "hi" });

    await stream.close();
    await settleSoon(iterator.next());
  });

  it("retries a transient mapping failure instead of skipping the message", async () => {
    // Client errors marked retryable (network blips, gateway restarts) must
    // keep the old retry-via-reconnect behavior — delivered late, not lost.
    const validMessage = {
      guid: "msg-transient",
      chatGuids: ["s1"],
      content: { attachments: [], formatting: [], mentions: [], text: "yo" },
      dateCreated: new Date(1_700_000_000_000),
      isFromMe: false,
      sender: { address: "+15550111" },
    };
    let failuresLeft = 1;
    const flakyEvent = {
      type: "message.received",
      sequence: 1,
      chatGuid: "s1",
      isFromMe: false,
      get message() {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error("UNAVAILABLE: gateway restarting"), {
            retryable: true,
          });
        }
        return validMessage;
      },
    };

    const idleAfter = (events: unknown[]) => {
      let index = 0;
      const idle = idleEventStream();
      return {
        close: idle.close,
        [Symbol.asyncIterator]() {
          const idleIterator = idle[Symbol.asyncIterator]();
          return {
            next(): Promise<IteratorResult<unknown, undefined>> {
              if (index < events.length) {
                const value = events[index];
                index += 1;
                return Promise.resolve({ done: false, value });
              }
              return idleIterator.next();
            },
            return(): Promise<IteratorResult<unknown, undefined>> {
              return idleIterator.return();
            },
          };
        },
      };
    };

    const entry: RemoteClient = {
      phone: SHARED_PHONE,
      client: {
        // Reconnect resubscribes; the same event replays and now maps.
        messages: { subscribeEvents: () => idleAfter([flakyEvent]) },
        polls: { subscribeEvents: idleEventStream },
      } as unknown as AdvancedIMessage,
    };

    const stream = messages([entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value?.id).toBe("msg-transient");
    expect(failuresLeft).toBe(0);

    await stream.close();
    await settleSoon(iterator.next());
  }, 15_000);

  it("surfaces an inbound read receipt", async () => {
    const { entry } = readReceiptClient("+15550100", [
      readEvent(1, "s1", "+15550111"),
    ]);

    const stream = messages([entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value?.id).toBe("msg-out:read:1");
    expect(first.value?.sender?.id).toBe("+15550111");
    expect(first.value?.timestamp).toEqual(READ_DATE);
    expect(first.value?.content.type).toBe("read");
    if (first.value?.content.type === "read") {
      expect(first.value.content.target.id).toBe("msg-out");
      expect(first.value.content.target.direction).toBe("outbound");
    }

    await stream.close();
    await settleSoon(iterator.next());
  });

  it("surfaces a DM receipt whose actor is the line's own address", async () => {
    // Real-line shape (ENG-2101): on `message.read` the platform reports
    // `actor` as *our own* line even when the peer did the reading. Suppressing
    // on that would drop every genuine receipt, so the peer is recovered from
    // the DM chat guid instead.
    const { entry } = readReceiptClient("+15550100", [
      readEvent(1, "any;-;+15550111", "+15550100"),
    ]);

    const stream = messages([entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.content.type).toBe("read");
    expect(first.value?.sender?.id).toBe("+15550111");

    await stream.close();
    await settleSoon(iterator.next());
  });

  it("advances the cursor past a receipt with no identifiable reader", async () => {
    // A dropped receipt must not wedge the stream: the event after it still
    // has to be delivered. Same shape as the unmappable-event test above.
    // A group guid carries no participants, so an actor of our own line leaves
    // the reader unknown.
    const { entry } = readReceiptClient("+15550100", [
      readEvent(1, "iMessage;+;chat9", "+15550100"),
      inboundEvent(2, "s1"),
    ]);

    const stream = messages([entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value?.content).toMatchObject({ type: "text", text: "hi" });

    await stream.close();
    await settleSoon(iterator.next());
  });

  it("drops a receipt targeting one of their inbound messages", async () => {
    // The echo of our own `chats.markRead()`: it marks *their* messages, so
    // the resolved target is inbound and must not surface.
    const entry: RemoteClient = {
      phone: "+15550100",
      client: {
        messages: {
          get: vi.fn((_message: string) =>
            Promise.resolve({
              ...sentMessage("msg-theirs"),
              isFromMe: false,
              sender: { address: "+15550111" },
            })
          ),
          subscribeEvents: () =>
            finiteEventStream([
              readEvent(1, "s1", "+15550111", "msg-theirs"),
              inboundEvent(2, "s1"),
            ]),
        },
        polls: { subscribeEvents: idleEventStream },
        groups: { subscribeEvents: idleEventStream },
      } as unknown as AdvancedIMessage,
    };

    const stream = messages([entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.id).toBe("msg-2");

    await stream.close();
    await settleSoon(iterator.next());
  });
});
