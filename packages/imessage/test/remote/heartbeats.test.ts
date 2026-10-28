import {
  type AdvancedIMessage,
  createGrpcClient,
  type MessageEvent,
} from "@photon-ai/advanced-imessage/grpc";
import { type ProjectData, Spectrum } from "@spectrum-ts/core";
import { resumableOrderedStream } from "@spectrum-ts/core/authoring";
import { stubCloud } from "@spectrum-ts/test-support/cloud";
import { makeQueue } from "@spectrum-ts/test-support/platform";
import { flush } from "@spectrum-ts/test-support/timing";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type IMessageHeartbeat, imessage } from "@/index";
import {
  lineKey,
  notifyLineAttached,
  notifyLineDetached,
  setLineId,
} from "@/lines";
import { messages } from "@/remote/stream";
import { type RemoteClient, SHARED_PHONE } from "@/types";

vi.mock("@photon-ai/advanced-imessage/grpc", async (original) => ({
  ...(await original<typeof import("@photon-ai/advanced-imessage/grpc")>()),
  createGrpcClient: vi.fn(),
}));
vi.mock("@spectrum-ts/core/authoring", async (original) => {
  const actual = await original<typeof import("@spectrum-ts/core/authoring")>();
  return {
    ...actual,
    resumableOrderedStream: vi.fn(actual.resumableOrderedStream),
  };
});
const diagnostics = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
const PRIVATE_DIAGNOSTIC_DATA = /do-not-log|\+1555|unused\.test/;
vi.mock("@photon-ai/otel", async (original) => {
  const actual = await original<typeof import("@photon-ai/otel")>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const logger = actual.createLogger(...args);
      return args[0] === "spectrum.stream"
        ? { ...logger, ...diagnostics }
        : logger;
    },
  };
});
const pendingWarnings = () =>
  diagnostics.warn.mock.calls.filter(
    ([message]) => message === "stream operation still pending"
  );
const settlements = () =>
  diagnostics.info.mock.calls.filter(
    ([message]) => message === "previously pending stream operation settled"
  );
stubCloud();
afterEach(() => {
  vi.mocked(resumableOrderedStream).mockClear();
  diagnostics.warn.mockClear();
  diagnostics.info.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const PROJECT: ProjectData = {
  id: "proj",
  name: "Test",
  slug: "test",
  profile: {},
};
const HEARTBEAT = Symbol("heartbeat");

const resource = () => {
  const subscriptions: {
    heartbeat(): void;
    event(event: MessageEvent): void;
    disconnect(): void;
    lateHeartbeat(): void;
  }[] = [];
  const subscribeEvents = vi.fn((filter?: { onHeartbeat?: () => void }) => {
    const queue = makeQueue<MessageEvent | typeof HEARTBEAT>();
    let closed = false;
    // Like the SDK, frames only notify the observer when the iterator pulls.
    const source = (async function* () {
      for await (const frame of queue.iter) {
        if (closed) {
          return;
        }
        if (frame === HEARTBEAT) {
          filter?.onHeartbeat?.();
        } else {
          yield frame;
        }
      }
    })();
    subscriptions.push({
      heartbeat: () => queue.push(HEARTBEAT),
      event: (event) => queue.push(event),
      disconnect: queue.close,
      // Deliberately bypass the SDK's own close guard to test our lifetime.
      lateHeartbeat: () => filter?.onHeartbeat?.(),
    });
    return Object.assign(source, {
      close: () => {
        closed = true;
        queue.close();
      },
    });
  });
  return { subscribeEvents, subscriptions };
};

const client = (phone = "+15550100") => {
  const messagesResource = { ...resource(), get: vi.fn() };
  const polls = resource();
  const groups = resource();
  const close = vi.fn();
  const catchUp = vi.fn();
  const entry: RemoteClient = {
    phone,
    client: {
      messages: messagesResource,
      polls,
      groups,
      close,
      events: { catchUp },
    } as unknown as AdvancedIMessage,
  };
  return { entry, messages: messagesResource, polls, groups, close, catchUp };
};

const start = async (
  entries: RemoteClient[],
  onHeartbeat?: (heartbeat: IMessageHeartbeat) => void | Promise<void>
) => {
  const source = messages(entries, PROJECT, undefined, onHeartbeat);
  const iterator = source[Symbol.asyncIterator]();
  const first = iterator.next();
  onTestFinished(async () => {
    await source.close();
    await first;
  });
  await flush();
  return { source, iterator, first };
};

const inbound = {
  type: "message.received",
  sequence: 1,
  chatGuid: "iMessage;-;+15550111",
  isFromMe: false,
  occurredAt: new Date(1_700_000_000_000),
  message: {
    guid: "m1",
    chatGuids: ["iMessage;-;+15550111"],
    content: { text: "hello", attachments: [], formatting: [], mentions: [] },
    dateCreated: new Date(1_700_000_000_000),
    isFromMe: false,
    sender: { address: "+15550111" },
  },
} as unknown as MessageEvent;

const readEvent = {
  type: "message.read",
  sequence: 2,
  chatGuid: "iMessage;-;+15550111",
  messageGuid: "outbound",
  occurredAt: new Date(),
  readAt: new Date(),
  isFromMe: true,
} as MessageEvent;

const current = (r: ReturnType<typeof resource>) => {
  const subscription = r.subscriptions.at(-1);
  if (!subscription) {
    throw new Error("Subscription did not start");
  }
  return subscription;
};

describe("identified iMessage heartbeats", () => {
  it("reports quiet stream heartbeats separately from messages and missing sibling heartbeats", async () => {
    const remote = client();
    const observed: IMessageHeartbeat[] = [];
    const { first } = await start([remote.entry], (event) => {
      observed.push(event);
    });
    let delivered = false;
    first.then(() => {
      delivered = true;
    });
    current(remote.messages).heartbeat();
    current(remote.messages).heartbeat();
    current(remote.polls).heartbeat();
    await flush();
    expect(observed.map((event) => event.stream).sort()).toEqual([
      "messages",
      "messages",
      "polls",
    ]);
    expect(observed[0]).toMatchObject({
      provider: "imessage",
      projectId: "proj",
      lineId: lineKey(remote.entry),
      phone: remote.entry.phone,
      receivedAt: expect.any(Number),
      subscriptionId: expect.any(String),
    });
    const messageSignals = observed.filter(
      (event) => event.stream === "messages"
    );
    const pollSignal = observed.find((event) => event.stream === "polls");
    expect(messageSignals[0]?.subscriptionId).toBe(
      messageSignals[1]?.subscriptionId
    );
    expect(messageSignals[0]?.subscriptionId).not.toBe(
      pollSignal?.subscriptionId
    );
    expect(delivered).toBe(false);
    expect(remote.groups.subscribeEvents).toHaveBeenCalledTimes(1);
    // No synthetic tick or notification for the silent groups subscription.
    await flush();
    expect(observed).toHaveLength(3);
  });

  it("distinguishes lines even when their phone numbers match", async () => {
    const left = client();
    const right = client();
    setLineId(left.entry, "cloud-instance-1");
    const observed: IMessageHeartbeat[] = [];
    await start([left.entry, right.entry], (event) => {
      observed.push(event);
    });
    current(left.messages).heartbeat();
    current(right.messages).heartbeat();
    current(left.groups).heartbeat();
    await flush();
    expect(new Set(observed.map((event) => event.lineId))).toEqual(
      new Set(["cloud-instance-1", lineKey(right.entry)])
    );
    expect(new Set(observed.map((event) => event.subscriptionId)).size).toBe(3);
    expect(new Set(observed.map((event) => event.phone)).size).toBe(1);
    expect(observed.map((event) => event.stream)).toContain("groups");
  });

  it("keeps the shared-mode subscription set unchanged", async () => {
    const remote = client(SHARED_PHONE);
    const observer = vi.fn();
    await start([remote.entry], observer);
    current(remote.messages).heartbeat();
    current(remote.polls).heartbeat();
    await flush();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(remote.groups.subscribeEvents).not.toHaveBeenCalled();
  });

  it("does nothing when the optional observer is absent", async () => {
    const remote = client();
    await start([remote.entry]);
    current(remote.messages).heartbeat();
    await flush();
    expect(remote.messages.subscribeEvents).toHaveBeenCalledTimes(1);
  });

  it("assigns a new subscription identity on reconnect and rejects old callbacks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remote = client();
    const observed: IMessageHeartbeat[] = [];
    await start([remote.entry], (event) => {
      observed.push(event);
    });
    const old = current(remote.messages);
    old.heartbeat();
    await flush();
    old.disconnect();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(remote.messages.subscribeEvents).toHaveBeenCalledTimes(2);
    old.lateHeartbeat();
    current(remote.messages).heartbeat();
    await flush();
    expect(observed).toHaveLength(2);
    expect(observed[0]?.lineId).toBe(observed[1]?.lineId);
    expect(observed[0]?.subscriptionId).not.toBe(observed[1]?.subscriptionId);
  });

  it("uses the new live subscription while reconnect catch-up is still pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remote = client();
    const replay = makeQueue<{
      type: "catchup.complete";
      headSequence: number;
    }>();
    remote.catchUp.mockReturnValue(replay.iter);
    const observed: IMessageHeartbeat[] = [];
    const { first, iterator, source } = await start([remote.entry], (event) => {
      observed.push(event);
    });
    const old = current(remote.messages);
    old.heartbeat();
    old.event(inbound);
    await first;
    const next = iterator.next();
    try {
      await flush();
      old.disconnect();
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(remote.catchUp).toHaveBeenCalledWith(1);
      old.lateHeartbeat();
      current(remote.messages).heartbeat();
      await flush();
      expect(observed).toHaveLength(2);
      expect(observed[0]?.subscriptionId).not.toBe(observed[1]?.subscriptionId);
      replay.push({ type: "catchup.complete", headSequence: 1 });
      await flush();
    } finally {
      replay.close();
      await source.close();
      await next;
    }
  });

  it("retires hooks on line removal and stream close without duplicating reconciled subscriptions", async () => {
    const remote = client();
    const entries = [remote.entry];
    const observer = vi.fn();
    const { source } = await start(entries, observer);
    const old = current(remote.messages);
    notifyLineAttached(entries, remote.entry);
    await flush();
    expect(remote.messages.subscribeEvents).toHaveBeenCalledTimes(1);
    await Promise.all(notifyLineDetached(entries, remote.entry));
    old.lateHeartbeat();
    expect(observer).not.toHaveBeenCalled();
    notifyLineAttached(entries, remote.entry);
    await flush();
    current(remote.messages).heartbeat();
    await flush();
    expect(observer).toHaveBeenCalledTimes(1);
    await source.close();
    for (const r of [remote.messages, remote.polls, remote.groups]) {
      current(r).lateHeartbeat();
    }
    notifyLineAttached(entries, remote.entry);
    await flush();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(remote.messages.subscribeEvents).toHaveBeenCalledTimes(2);
  });

  it.each([
    "throw",
    "reject",
  ])("contains an observer %s without reconnecting", async (mode) => {
    const remote = client();
    const observer = vi.fn(() => {
      if (mode === "throw") {
        throw new Error("observer failed");
      }
      return Promise.reject(new Error("observer failed"));
    });
    await start([remote.entry], observer);
    current(remote.messages).heartbeat();
    current(remote.messages).heartbeat();
    await flush();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(remote.messages.subscribeEvents).toHaveBeenCalledTimes(1);
  });

  it("does not await an asynchronous observer during receipt or shutdown", async () => {
    const remote = client();
    const completion = Promise.withResolvers<void>();
    onTestFinished(() => completion.resolve());
    const observer = vi.fn(() => completion.promise);
    const { source } = await start([remote.entry], observer);
    current(remote.messages).heartbeat();
    current(remote.messages).heartbeat();
    await flush();
    expect(observer).toHaveBeenCalledTimes(2);
    await source.close();
    current(remote.messages).lateHeartbeat();
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("keeps sibling heartbeats distinct while application backpressure pauses messages", async () => {
    const remote = client();
    const observed: IMessageHeartbeat[] = [];
    const { first, iterator, source } = await start([remote.entry], (event) => {
      observed.push(event);
    });
    current(remote.messages).event(inbound);
    expect((await first).done).toBe(false);
    current(remote.messages).heartbeat();
    current(remote.polls).heartbeat();
    await flush();
    expect(observed.map((event) => event.stream)).toEqual(["polls"]);
    const next = iterator.next();
    await flush();
    expect(observed.map((event) => event.stream)).toEqual([
      "polls",
      "messages",
    ]);
    await source.close();
    await next;
  });

  it("does not pretend to observe a blocked mapper's queued heartbeat through a healthy sibling", async () => {
    const remote = client();
    let release!: () => void;
    remote.messages.get.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const observed: IMessageHeartbeat[] = [];
    await start([remote.entry], (event) => {
      observed.push(event);
    });
    try {
      current(remote.messages).event(readEvent);
      await flush();
      expect(remote.messages.get).toHaveBeenCalledTimes(1);
      current(remote.messages).heartbeat();
      current(remote.polls).heartbeat();
      await flush();
      expect(observed.map((event) => event.stream)).toEqual(["polls"]);
    } finally {
      release();
    }
    await flush();
    expect(observed.map((event) => event.stream)).toEqual([
      "polls",
      "messages",
    ]);
  });

  it.each([
    true,
    false,
  ])("preserves the configured function through real Spectrum startup and stop (Cloud project: %s)", async (withProject) => {
    const remote = client();
    vi.mocked(createGrpcClient).mockReturnValue(remote.entry.client);
    vi.stubEnv("SPECTRUM_PROJECT_ID", undefined);
    vi.stubEnv("SPECTRUM_PROJECT_SECRET", undefined);
    const observer = vi.fn();
    const options = {
      telemetry: false,
      providers: [
        imessage.config({
          clients: {
            address: "unused.test:443",
            token: "test-token",
            phone: remote.entry.phone,
          },
          onHeartbeat: observer,
        }),
      ],
    };
    const app = await (withProject
      ? Spectrum({ ...options, projectId: "proj", projectSecret: "secret" })
      : Spectrum(options));
    onTestFinished(() => app.stop());
    const pending = app.messages[Symbol.asyncIterator]().next();
    await flush();
    current(remote.messages).heartbeat();
    await flush();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]?.[0]).toMatchObject({
      projectId: withProject ? "proj" : undefined,
      provider: "imessage",
    });
    await app.stop();
    current(remote.messages).lateHeartbeat();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
    expect((await pending).done).toBe(true);
  });
});

describe("iMessage pending processing diagnostics", () => {
  it("wires raw event and catch-up head metadata into every stream", async () => {
    await start([client().entry]);
    const calls = vi.mocked(resumableOrderedStream).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [options] of calls) {
      expect(options.eventDiagnosticAttrs?.(readEvent)).toEqual({
        "spectrum.stream.event_cursor": "2",
        "spectrum.stream.event_cursor_kind": "event",
        "spectrum.stream.event_type": "message.read",
      });
      expect(
        options.eventDiagnosticAttrs?.({
          type: "catchup.complete",
          headSequence: 99,
        })
      ).toEqual({
        "spectrum.stream.event_cursor": "99",
        "spectrum.stream.event_cursor_kind": "catch-up-head",
        "spectrum.stream.event_type": "catchup.complete",
      });
    }
  });

  it("labels a held historical mapper with its concurrent live generation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const remote = client();
    const completion = Promise.withResolvers<void>();
    remote.messages.get.mockReturnValue(completion.promise);
    const replay = makeQueue<MessageEvent>();
    remote.catchUp.mockReturnValue(replay.iter);
    const observed: IMessageHeartbeat[] = [];
    const { first, iterator, source } = await start([remote.entry], (event) => {
      observed.push(event);
    });
    current(remote.messages).heartbeat();
    current(remote.messages).event(inbound);
    await first;
    const next = iterator.next();
    try {
      await flush();
      current(remote.messages).disconnect();
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(remote.catchUp).toHaveBeenCalledWith(1);
      replay.push(readEvent);
      current(remote.messages).heartbeat();
      await flush();
      expect(remote.messages.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pendingWarnings()).toHaveLength(1);
      expect(observed).toHaveLength(2);
      expect(observed[1]?.subscriptionId).not.toBe(observed[0]?.subscriptionId);
      expect(pendingWarnings()[0]?.[1]).toMatchObject({
        subscriptionId: observed[1]?.subscriptionId,
        "spectrum.stream.origin": "catch-up",
        "spectrum.stream.subscription_role": "concurrent-live",
        "spectrum.stream.event_cursor": "2",
        "spectrum.stream.cursor": "1",
        "spectrum.stream.operation": "mapping",
      });
    } finally {
      completion.resolve();
      replay.close();
      await source.close();
      await next;
    }
  });
  it.each([
    true,
    false,
  ])("identifies the blocked line and raw cursor with a heartbeat observer: %s", async (withObserver) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const remote = client();
    const sibling = client();
    setLineId(remote.entry, "cloud-instance-1");
    setLineId(sibling.entry, "cloud-instance-2");
    const completion = Promise.withResolvers<void>();
    remote.messages.get.mockReturnValue(completion.promise);
    const observed: IMessageHeartbeat[] = [];
    await start(
      [remote.entry, sibling.entry],
      withObserver
        ? (event) => {
            observed.push(event);
          }
        : undefined
    );
    try {
      current(remote.messages).heartbeat();
      current(sibling.messages).heartbeat();
      await flush();
      current(remote.messages).event(readEvent);
      await flush();
      expect(remote.messages.get).toHaveBeenCalledTimes(1);
      current(remote.messages).heartbeat();
      current(remote.polls).heartbeat();
      current(sibling.messages).heartbeat();
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pendingWarnings()).toHaveLength(1);
      const attrs = pendingWarnings()[0]?.[1];
      expect(attrs).toMatchObject({
        provider: "imessage",
        projectId: "proj",
        lineId: "cloud-instance-1",
        stream: "messages",
        subscriptionId: expect.any(String),
        "spectrum.stream.operation": "mapping",
        "spectrum.stream.origin": "live",
        "spectrum.stream.event_cursor": "2",
        "spectrum.stream.event_cursor_kind": "event",
        "spectrum.stream.event_type": "message.read",
        "spectrum.stream.cursor": undefined,
      });
      const serialized = JSON.stringify(pendingWarnings());
      expect(serialized).not.toContain("+1555");
      expect(serialized).not.toContain("outbound");
      expect(serialized).not.toContain("chatGuid");
      if (withObserver) {
        expect(attrs.subscriptionId).toBe(observed[0]?.subscriptionId);
        expect(attrs.subscriptionId).not.toBe(observed.at(-1)?.subscriptionId);
      } else {
        expect(observed).toHaveLength(0);
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pendingWarnings()).toHaveLength(1);
      expect(remote.messages.subscribeEvents).toHaveBeenCalledTimes(1);
    } finally {
      completion.resolve();
    }
    await flush();
    expect(settlements()[0]?.[1]).toMatchObject({
      "spectrum.stream.operation": "mapping",
      "spectrum.stream.outcome": "completed",
    });
  });

  it("does not mistake healthy sibling heartbeats for application-consumer progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const remote = client();
    const observed: IMessageHeartbeat[] = [];
    const { first, iterator, source } = await start([remote.entry], (event) => {
      observed.push(event);
    });
    current(remote.messages).heartbeat();
    await flush();
    current(remote.messages).event(inbound);
    expect((await first).done).toBe(false);
    current(remote.messages).heartbeat();
    current(remote.polls).heartbeat();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pendingWarnings()).toHaveLength(1);
    expect(pendingWarnings()[0]?.[1]).toMatchObject({
      subscriptionId: observed[0]?.subscriptionId,
      "spectrum.stream.operation": "emit",
      "spectrum.stream.event_cursor": "1",
    });
    expect(observed.map((event) => event.stream)).toEqual([
      "messages",
      "polls",
    ]);
    const next = iterator.next();
    await flush();
    expect(settlements()[0]?.[1]).toMatchObject({
      "spectrum.stream.operation": "emit",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pendingWarnings()).toHaveLength(1);
    await source.close();
    await next;
  });

  it("retires a removed line's diagnostics while its mapping cleanup is still blocked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const old = client();
    const replacement = client();
    setLineId(old.entry, "same-cloud-instance");
    setLineId(replacement.entry, "same-cloud-instance");
    const oldMapping = Promise.withResolvers<void>();
    const newMapping = Promise.withResolvers<void>();
    old.messages.get.mockReturnValue(oldMapping.promise);
    replacement.messages.get.mockReturnValue(newMapping.promise);
    const entries = [old.entry];
    const observed: IMessageHeartbeat[] = [];
    await start(entries, (event) => {
      observed.push(event);
    });
    try {
      current(old.messages).heartbeat();
      current(old.messages).event(readEvent);
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pendingWarnings()).toHaveLength(1);
      const oldId = observed[0]?.subscriptionId;
      const detaching = Promise.all(notifyLineDetached(entries, old.entry));
      let detached = false;
      detaching.then(() => {
        detached = true;
      });
      await flush();
      expect(detached).toBe(false);
      entries.splice(0, 1, replacement.entry);
      notifyLineAttached(entries, replacement.entry);
      await flush();
      current(old.messages).lateHeartbeat();
      current(replacement.messages).heartbeat();
      current(replacement.messages).event(readEvent);
      await flush();
      expect(observed).toHaveLength(2);
      const newId = observed[1]?.subscriptionId;
      expect(newId).not.toBe(oldId);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        pendingWarnings().map(([, attrs]) => attrs.subscriptionId)
      ).toEqual([oldId, newId]);
      oldMapping.resolve();
      await detaching;
      expect(settlements()).toHaveLength(0);
      newMapping.resolve();
      await flush();
      expect(settlements().map(([, attrs]) => attrs.subscriptionId)).toEqual([
        newId,
      ]);
    } finally {
      oldMapping.resolve();
      newMapping.resolve();
    }
  });

  it("enables bounded warnings through real Spectrum config without a heartbeat observer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const remote = client();
    const completion = Promise.withResolvers<void>();
    remote.messages.get.mockReturnValue(completion.promise);
    vi.mocked(createGrpcClient).mockReturnValue(remote.entry.client);
    const app = await Spectrum({
      projectId: "proj",
      projectSecret: "do-not-log-secret",
      telemetry: false,
      providers: [
        imessage.config({
          clients: {
            address: "unused.test:443",
            token: "do-not-log-token",
            phone: remote.entry.phone,
          },
        }),
      ],
    });
    const pending = app.messages[Symbol.asyncIterator]().next();
    try {
      await flush();
      current(remote.messages).event(readEvent);
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pendingWarnings()).toHaveLength(1);
      expect(pendingWarnings()[0]?.[1]).toMatchObject({
        provider: "imessage",
        projectId: "proj",
        "spectrum.stream.operation": "mapping",
      });
      expect(JSON.stringify(pendingWarnings())).not.toMatch(
        PRIVATE_DIAGNOSTIC_DATA
      );
    } finally {
      completion.resolve();
      await app.stop();
      await pending;
    }
  });
});
