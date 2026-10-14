// Related-content access through the real `messages()` stream: reaction,
// read-receipt, reply and poll-vote payloads embed *other* content, and the
// local assembly caches must never decide whether that content is visible.
// Every test drives `resumableOrderedStream` end to end, including the
// catch-up path a retryable failure falls back to.
import {
  type AdvancedIMessage,
  ConnectionError,
  NotFoundError,
} from "@photon-ai/advanced-imessage/grpc";
import {
  NO_MESSAGE_WAIT_MS,
  settleSoon,
  withinMs,
} from "@spectrum-ts/test-support/timing";
import { describe, expect, it, vi } from "vitest";
import { getMessageCache, getPollCache } from "@/cache";
import { cachePollEvent } from "@/remote/polls";
import { messages } from "@/remote/stream";
import type { IMessageMessage, RemoteClient } from "@/types";

const PHONE = "+15550100";
const PEER = "+15550111";
const DM = `any;-;${PEER}`;
const AT = new Date(1_700_000_000_000);
const ATTACHMENT_PLACEHOLDER = "\uFFFC";
// Generous: the first reconnect sleeps a jittered 250-500ms.
const RETRY_TEST_TIMEOUT_MS = 15_000;
const OK_POLL_ID = /^ok-poll:/;

const notFound = () =>
  new NotFoundError("hidden", {
    code: "messageNotFound",
    grpcCode: 5,
    retryable: false,
  });

const unavailable = () =>
  new ConnectionError("access check unavailable", {
    code: "serviceUnavailable",
    grpcCode: 14,
    retryable: true,
  });

// The SDK maps NOT_FOUND to NotFoundError but copies `x-retryable` into it
// independently, so a transient NOT_FOUND is not a definitive absence.
const retryableNotFound = () =>
  new NotFoundError("replica lagging", {
    code: "messageNotFound",
    grpcCode: 5,
    retryable: true,
  });

const idleStream = () => {
  let release: (() => void) | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    release?.();
    return Promise.resolve();
  };
  return {
    close,
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<never, undefined>> =>
          closed
            ? Promise.resolve({ done: true, value: undefined })
            : new Promise((resolve) => {
                release = () => resolve({ done: true, value: undefined });
              }),
        return: () =>
          close().then(
            (): IteratorResult<never, undefined> => ({
              done: true,
              value: undefined,
            })
          ),
      };
    },
  };
};

// Yields `events`, then idles so the subscription stays open.
const thenIdle = (events: readonly unknown[]) => {
  const idle = idleStream();
  let index = 0;
  return {
    close: idle.close,
    [Symbol.asyncIterator]() {
      const rest = idle[Symbol.asyncIterator]();
      return {
        next: (): Promise<IteratorResult<unknown, undefined>> => {
          const value = events[index];
          if (index < events.length) {
            index += 1;
            return Promise.resolve({ done: false, value });
          }
          return rest.next();
        },
        return: rest.return,
      };
    },
  };
};

/**
 * One line whose live subscriptions replay `live[n]` on the n-th subscribe
 * (idle afterwards) and whose catch-up replays `catchUp(since)`.
 */
const scriptedLine = (options: {
  catchUp?: (since: number) => readonly unknown[];
  get?: (guid: string) => Promise<unknown>;
  live: readonly (readonly unknown[])[];
  pollsGet?: (guid: string) => Promise<unknown>;
  stream: "messages" | "polls";
}) => {
  let subscriptions = 0;
  const subscribe = () => {
    const events = options.live[subscriptions] ?? [];
    subscriptions += 1;
    return thenIdle(events);
  };
  const catchUp = vi.fn((since: number) =>
    thenIdle(options.catchUp?.(since) ?? [])
  );
  const get = vi.fn(options.get ?? (() => Promise.reject(notFound())));
  const pollsGet = vi.fn(
    options.pollsGet ?? (() => Promise.reject(notFound()))
  );
  const client = {
    events: { catchUp },
    groups: { subscribeEvents: idleStream },
    messages: {
      get,
      subscribeEvents: options.stream === "messages" ? subscribe : idleStream,
    },
    polls: {
      get: pollsGet,
      subscribeEvents: options.stream === "polls" ? subscribe : idleStream,
    },
  } as unknown as AdvancedIMessage;
  const entry: RemoteClient = { client, phone: PHONE };
  return { catchUp, client, entry, get, pollsGet };
};

const nativeText = (guid: string, text: string, overrides = {}) => ({
  chatGuids: [DM],
  content: { attachments: [], formatting: [], mentions: [], text },
  dateCreated: AT,
  guid,
  isFromMe: true,
  sender: { address: PHONE },
  ...overrides,
});

const received = (sequence: number, message: Record<string, unknown>) => ({
  chatGuid: DM,
  isFromMe: false,
  message: { ...message, isFromMe: false, sender: { address: PEER } },
  occurredAt: AT,
  sequence,
  type: "message.received",
});

const reaction = (sequence: number, messageGuid: string, part?: number) => ({
  actor: { address: PEER },
  chatGuid: DM,
  isFromMe: false,
  messageGuid,
  occurredAt: AT,
  reaction: { kind: "like" },
  sequence,
  ...(part === undefined ? {} : { targetPartIndex: part }),
  type: "message.reactionAdded",
});

const readReceipt = (sequence: number, messageGuid: string) => ({
  actor: { address: PHONE },
  chatGuid: DM,
  isFromMe: true,
  messageGuid,
  occurredAt: AT,
  readAt: AT,
  sequence,
  type: "message.read",
});

const complete = (headSequence: number) => ({
  headSequence,
  type: "catchup.complete",
});

// An entry the SDK cached while the content was still visible.
const staleEntry = (id: string, text: string): IMessageMessage =>
  ({
    content: { text: `stale ${text}`, type: "text" },
    direction: "outbound",
    id,
    sender: { id: PHONE },
    space: { id: DM, phone: PHONE, type: "dm" },
    timestamp: AT,
  }) as IMessageMessage;

// Waits for anything else (e.g. a duplicate after a retry) to be delivered,
// then closes the stream; resolves "timeout" when nothing arrived. Takes the
// stream rather than returning the pending pull: an async function returning
// that promise would adopt it and never settle.
const nextThenClose = async (
  stream: {
    [Symbol.asyncIterator]: () => AsyncIterator<IMessageMessage>;
    close: () => Promise<void>;
  },
  iterator: AsyncIterator<IMessageMessage>
): Promise<string> => {
  const pending = iterator.next();
  const outcome = await withinMs(pending, NO_MESSAGE_WAIT_MS);
  await stream.close();
  await settleSoon(pending);
  return outcome;
};

describe("stream related-content access", () => {
  it.each([
    ["UNAVAILABLE", unavailable],
    ["retryable NOT_FOUND", retryableNotFound],
  ])(
    "advances past hidden-only events, retries a %s target without advancing, then emits once",
    async (_label, transientFailure) => {
      let flakyCalls = 0;
      const line = scriptedLine({
        stream: "messages",
        live: [
          [
            reaction(1, "hidden-target"),
            readReceipt(2, "hidden-target"),
            reaction(3, "flaky-target", 1),
          ],
        ],
        catchUp: (since) =>
          since === 2 ? [reaction(3, "flaky-target", 1), complete(3)] : [],
        get: (guid) => {
          if (guid === "hidden-target") {
            return Promise.reject(notFound());
          }
          flakyCalls += 1;
          return flakyCalls === 1
            ? Promise.reject(transientFailure())
            : Promise.resolve(
                nativeText(guid, `fresh caption ${ATTACHMENT_PLACEHOLDER}`, {
                  content: {
                    attachments: [
                      {
                        fileName: "fresh.png",
                        guid: "fresh-attachment",
                        mimeType: "image/png",
                        totalBytes: 1,
                        uti: "public.png",
                      },
                    ],
                    formatting: [],
                    mentions: [],
                    text: `fresh caption ${ATTACHMENT_PLACEHOLDER}`,
                  },
                })
              );
        },
      });
      const cache = getMessageCache(line.client);
      cache.set("hidden-target", staleEntry("hidden-target", "hidden"));
      cache.set("flaky-target", staleEntry("flaky-target", "parent"));
      cache.set("p:1/flaky-target", staleEntry("p:1/flaky-target", "part"));

      const stream = messages([line.entry]);
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();

      // Hidden reaction + receipt advanced the cursor to 2; the retryable
      // failure on 3 did not, so catch-up resumes after 2.
      expect(line.catchUp).toHaveBeenCalledExactlyOnceWith(2);
      expect(first.value?.id).toBe("flaky-target:reaction:3:1");
      const content = first.value?.content;
      if (content?.type !== "reaction") {
        throw new Error("expected reaction content");
      }
      const target = content.target as unknown as IMessageMessage;
      expect(target.id).toBe("p:1/flaky-target");
      expect(target.partIndex).toBe(1);
      expect(target.content).toMatchObject({
        id: "fresh-attachment",
        type: "attachment",
      });
      expect(JSON.stringify(first.value)).not.toContain("stale");
      expect(
        line.get.mock.calls.filter(([guid]) => guid === "hidden-target")
      ).toHaveLength(2);
      // Failed once live, fetched again on catch-up.
      expect(flakyCalls).toBe(2);

      expect(await nextThenClose(stream, iterator)).toBe("timeout");
    },
    RETRY_TEST_TIMEOUT_MS
  );

  it("drops a read receipt whose cached outbound target the remote now denies", async () => {
    // e.g. an outbound message sent before the current assignment: the
    // send-time cache entry must not resurrect it inside a receipt.
    const line = scriptedLine({
      stream: "messages",
      live: [
        [
          readReceipt(1, "old-outbound"),
          received(2, nativeText("msg-2", "after")),
        ],
      ],
    });
    getMessageCache(line.client).set(
      "old-outbound",
      staleEntry("old-outbound", "outbound")
    );

    const stream = messages([line.entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.id).toBe("msg-2");
    expect(line.get).toHaveBeenCalledWith("old-outbound");

    expect(await nextThenClose(stream, iterator)).toBe("timeout");
  });

  it.each([
    ["denied", () => Promise.reject(notFound()), undefined],
    [
      "allowed with new text",
      (guid: string) =>
        Promise.resolve(
          // Replies back to the source: the chain must stay bounded.
          nativeText(guid, "edited target", { replyTargetGuid: "msg-1" })
        ),
      "edited target",
    ],
  ])("embeds only the upstream reply target when %s", async (_label, get, expectedText) => {
    const line = scriptedLine({
      stream: "messages",
      live: [
        [
          received(
            1,
            nativeText("msg-1", "reply", { replyTargetGuid: "target" })
          ),
        ],
      ],
      get,
    });
    getMessageCache(line.client).set("target", staleEntry("target", "x"));

    const stream = messages([line.entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(line.get).toHaveBeenCalledExactlyOnceWith("target");
    const content = first.value?.content;
    if (content?.type !== "reply") {
      throw new Error("expected reply content");
    }
    expect(JSON.stringify(first.value)).not.toContain("stale");
    if (expectedText === undefined) {
      expect(content.target.content).toEqual({
        raw: { imessage_type: "reply-target", stub: true },
        type: "custom",
      });
    } else {
      const nested = content.target.content;
      if (nested.type !== "reply") {
        throw new Error("expected nested reply content");
      }
      expect(nested.content).toEqual({ text: expectedText, type: "text" });
      expect(nested.target).toMatchObject({
        content: { raw: { stub: true }, type: "custom" },
        id: "msg-1",
      });
    }

    expect(await nextThenClose(stream, iterator)).toBe("timeout");
  });

  it(
    "retries a reply whose target access is unknown instead of stubbing it",
    async () => {
      let targetCalls = 0;
      const reply = received(
        2,
        nativeText("msg-2", "reply", { replyTargetGuid: "target" })
      );
      const line = scriptedLine({
        stream: "messages",
        live: [[received(1, nativeText("msg-1", "before")), reply]],
        catchUp: (since) => (since === 1 ? [reply, complete(2)] : []),
        get: (guid) => {
          targetCalls += 1;
          return targetCalls === 1
            ? Promise.reject(unavailable())
            : Promise.resolve(nativeText(guid, "fresh target"));
        },
      });

      const stream = messages([line.entry]);
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.id).toBe("msg-1");
      const second = await iterator.next();

      expect(line.catchUp).toHaveBeenCalledExactlyOnceWith(1);
      expect(second.value?.id).toBe("msg-2");
      expect(second.value?.content).toMatchObject({
        target: { content: { text: "fresh target", type: "text" } },
        type: "reply",
      });

      expect(await nextThenClose(stream, iterator)).toBe("timeout");
    },
    RETRY_TEST_TIMEOUT_MS
  );
});

const pollEvent = (
  sequence: number,
  pollMessageGuid: string,
  delta: Record<string, unknown>
) => ({
  actor: { address: PEER },
  chatGuid: DM,
  delta,
  isFromMe: false,
  occurredAt: AT,
  pollMessageGuid,
  sequence,
  type: "poll.changed",
});

const created = (sequence: number, guid: string) =>
  pollEvent(sequence, guid, {
    options: [
      { optionIdentifier: "o1", text: "stale option" },
      { optionIdentifier: "o9", text: "stale other" },
    ],
    title: "stale title",
    type: "created",
  });

const voted = (sequence: number, guid: string, optionIdentifier = "o1") =>
  pollEvent(sequence, guid, { optionIdentifier, type: "voted" });

const freshPoll = (
  pollMessageGuid: string,
  options = [
    { optionIdentifier: "o1", text: "fresh option" },
    { optionIdentifier: "o9", text: "fresh other" },
  ]
) => ({
  chatGuid: DM,
  options,
  pollMessageGuid,
  title: "fresh title",
  votes: [],
});

describe("stream poll metadata access", () => {
  it("drops a vote on a cached poll the remote now hides and keeps going", async () => {
    const line = scriptedLine({
      stream: "polls",
      live: [
        [
          created(1, "hidden-poll"),
          voted(2, "hidden-poll"),
          voted(3, "ok-poll"),
        ],
      ],
      pollsGet: (guid) =>
        guid === "hidden-poll"
          ? Promise.reject(notFound())
          : Promise.resolve(freshPoll(guid)),
    });

    const stream = messages([line.entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.id).toMatch(OK_POLL_ID);
    expect(first.value?.content).toMatchObject({
      poll: { title: "fresh title" },
      title: "fresh option",
      type: "poll_option",
    });
    // One fresh read per vote; no second "refresh" fetch for the hidden poll.
    expect(line.pollsGet.mock.calls).toEqual([["hidden-poll"], ["ok-poll"]]);

    expect(await nextThenClose(stream, iterator)).toBe("timeout");
  });

  it("emits fresh metadata instead of the cached poll and keeps synthetic ids", async () => {
    const line = scriptedLine({
      stream: "polls",
      live: [[voted(2, "poll")]],
      pollsGet: (guid) => Promise.resolve(freshPoll(guid)),
    });
    // The poll cache is keyed by the exact clients array the stream gets.
    const clients = [line.entry];
    cachePollEvent(
      getPollCache(clients),
      created(1, "poll") as Parameters<typeof cachePollEvent>[1]
    );

    const stream = messages(clients);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.id).toBe(`poll:${PEER}:o1:selected:${AT.getTime()}`);
    expect(first.value?.content).toMatchObject({
      poll: {
        options: [{ title: "fresh option" }, { title: "fresh other" }],
        title: "fresh title",
      },
      title: "fresh option",
    });
    expect(JSON.stringify(first.value)).not.toContain("stale");

    expect(await nextThenClose(stream, iterator)).toBe("timeout");
  });

  it("drops a vote for an option the fresh poll no longer has, without refetching", async () => {
    const line = scriptedLine({
      stream: "polls",
      live: [[created(1, "poll"), voted(2, "poll"), voted(3, "poll", "o2")]],
      pollsGet: (guid) =>
        Promise.resolve(
          freshPoll(guid, [
            { optionIdentifier: "o2", text: "fresh o2" },
            { optionIdentifier: "o9", text: "fresh other" },
          ])
        ),
    });

    const stream = messages([line.entry]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.content).toMatchObject({ title: "fresh o2" });
    expect(line.pollsGet).toHaveBeenCalledTimes(2);

    expect(await nextThenClose(stream, iterator)).toBe("timeout");
  });

  it(
    "retries a vote whose poll access is unknown without advancing, then emits once",
    async () => {
      let calls = 0;
      const line = scriptedLine({
        stream: "polls",
        live: [[created(1, "poll"), voted(2, "poll")]],
        catchUp: (since) =>
          since === 1 ? [voted(2, "poll"), complete(2)] : [],
        pollsGet: (guid) => {
          calls += 1;
          return calls === 1
            ? Promise.reject(unavailable())
            : Promise.resolve(freshPoll(guid));
        },
      });

      const stream = messages([line.entry]);
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();

      expect(line.catchUp).toHaveBeenCalledExactlyOnceWith(1);
      expect(first.value?.content).toMatchObject({
        poll: { title: "fresh title" },
      });

      expect(await nextThenClose(stream, iterator)).toBe("timeout");
    },
    RETRY_TEST_TIMEOUT_MS
  );
});
