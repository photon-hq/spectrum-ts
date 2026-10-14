import type {
  AdvancedIMessage,
  Poll as IMessagePoll,
  PollEvent,
} from "@photon-ai/advanced-imessage/grpc";
import { describe, expect, it, vi } from "vitest";
import { PollCache } from "@/cache";
import { cachePollEvent, toPollDeltaMessages } from "@/remote/polls";

const OCCURRED_AT = new Date(1_700_000_000_000);
const POLL_GUID = "poll-root-A";
const GROUP_GUID = "iMessage;+;chat123";
const PHONE = "+15550100";
const ACTOR = "+15550111";
const OPTIONS = [
  { optionIdentifier: "option-A", text: "Same label" },
  { optionIdentifier: "option-B", text: "Same label" },
];

const pollEvent = (
  delta: unknown,
  overrides: Partial<PollEvent> = {}
): PollEvent =>
  ({
    actor: { address: ACTOR },
    chatGuid: GROUP_GUID,
    delta,
    isFromMe: false,
    occurredAt: OCCURRED_AT,
    pollMessageGuid: POLL_GUID,
    sequence: 7,
    type: "poll.changed",
    ...overrides,
  }) as PollEvent;

const snapshotEvent = (
  type: "created" | "optionAdded" = "created",
  overrides: Partial<PollEvent> = {}
): PollEvent => pollEvent({ type, title: "", options: OPTIONS }, overrides);

const pollInfo = (overrides: Record<string, unknown> = {}): IMessagePoll =>
  ({
    chatGuid: GROUP_GUID,
    pollMessageGuid: POLL_GUID,
    title: "",
    options: OPTIONS,
    votes: [],
    ...overrides,
  }) as IMessagePoll;

const makeClient = () => {
  const get = vi.fn((_guid: string) => Promise.resolve(pollInfo()));
  const client = { polls: { get } } as unknown as AdvancedIMessage;
  return { client, get };
};

const PUBLIC_OPTIONS = OPTIONS.map((option) => ({
  title: option.text,
  optionIdentifier: option.optionIdentifier,
}));

const PUBLIC_POLL = {
  type: "poll",
  title: "",
  pollMessageGuid: POLL_GUID,
  options: PUBLIC_OPTIONS,
};

const VOTE_CASES = [
  { type: "voted", selected: true, action: "selected" },
  { type: "unvoted", selected: false, action: "deselected" },
] as const;

const SNAPSHOT_CASES = ["created", "optionAdded"] as const;

describe("iMessage poll conversion", () => {
  it.each(
    SNAPSHOT_CASES
  )("emits a titleless %s snapshot with identity", async (type) => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    const messages = await toPollDeltaMessages(
      client,
      cache,
      snapshotEvent(type),
      PHONE
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      id: type === "created" ? POLL_GUID : `${POLL_GUID}:poll:7`,
      sender: { id: ACTOR, address: ACTOR },
      space: { id: GROUP_GUID, type: "group", phone: PHONE },
      timestamp: OCCURRED_AT,
      content: { ...PUBLIC_POLL, change: type },
    });
    expect(cache.get(POLL_GUID)?.poll).toEqual(PUBLIC_POLL);
    expect(get).not.toHaveBeenCalled();
  });

  it("normalizes a missing native title to empty, not whitespace", async () => {
    const { client } = makeClient();
    const messages = await toPollDeltaMessages(
      client,
      new PollCache(),
      pollEvent({ type: "created", options: OPTIONS }),
      PHONE
    );
    expect(messages[0]?.content).toEqual({ ...PUBLIC_POLL, change: "created" });
  });

  it.each(SNAPSHOT_CASES)("allows a missing actor for %s", async (type) => {
    const { client } = makeClient();
    const messages = await toPollDeltaMessages(
      client,
      new PollCache(),
      snapshotEvent(type, { actor: undefined }),
      PHONE
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.sender).toBeUndefined();
  });

  it.each(
    VOTE_CASES
  )("resolves a titleless cold-cache $type with the stable vote ID", async ({
    type,
    selected,
    action,
  }) => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    const messages = await toPollDeltaMessages(
      client,
      cache,
      pollEvent({ type, optionIdentifier: "option-B" }),
      PHONE
    );
    expect(get).toHaveBeenCalledExactlyOnceWith(POLL_GUID);
    expect(messages[0]?.id).toBe(
      `${POLL_GUID}:${ACTOR}:option-B:${action}:${OCCURRED_AT.getTime()}`
    );
    expect(messages[0]?.content).toEqual({
      type: "poll_option",
      title: "Same label",
      option: { title: "Same label", optionIdentifier: "option-B" },
      poll: PUBLIC_POLL,
      pollMessageGuid: POLL_GUID,
      selected,
    });
    expect(cache.get(POLL_GUID)?.poll).toEqual(PUBLIC_POLL);
  });

  it("keeps identical labels and identical polls distinct by their native identifiers", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    const first = await toPollDeltaMessages(
      client,
      cache,
      snapshotEvent(),
      PHONE
    );
    const second = await toPollDeltaMessages(
      client,
      cache,
      snapshotEvent("created", { pollMessageGuid: "poll-root-B" }),
      PHONE
    );
    expect(first[0]?.id).toBe(POLL_GUID);
    expect(second[0]?.id).toBe("poll-root-B");
    for (const guid of [POLL_GUID, "poll-root-B"]) {
      for (const option of PUBLIC_OPTIONS) {
        const messages = await toPollDeltaMessages(
          client,
          cache,
          pollEvent(
            { type: "voted", optionIdentifier: option.optionIdentifier },
            { pollMessageGuid: guid }
          ),
          PHONE
        );
        expect(messages[0]?.content).toMatchObject({
          pollMessageGuid: guid,
          option,
          poll: { pollMessageGuid: guid },
        });
      }
    }
    expect(get).not.toHaveBeenCalled();
  });

  it.each(
    VOTE_CASES
  )("drops $type without an actor or option identifier before fetching", async ({
    type,
  }) => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    for (const event of [
      pollEvent({ type, optionIdentifier: "option-A" }, { actor: undefined }),
      pollEvent({ type, optionIdentifier: "" }),
    ]) {
      expect(await toPollDeltaMessages(client, cache, event, PHONE)).toEqual(
        []
      );
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("refreshes an unknown option once and maps its identifier", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    cachePollEvent(cache, snapshotEvent());
    get.mockResolvedValueOnce(
      pollInfo({
        options: [...OPTIONS, { optionIdentifier: "option-C", text: "New" }],
      })
    );
    const messages = await toPollDeltaMessages(
      client,
      cache,
      pollEvent({ type: "voted", optionIdentifier: "option-C" }),
      PHONE
    );
    expect(get).toHaveBeenCalledExactlyOnceWith(POLL_GUID);
    expect(messages[0]?.content).toMatchObject({
      option: { title: "New", optionIdentifier: "option-C" },
      pollMessageGuid: POLL_GUID,
      poll: {
        options: [
          ...PUBLIC_OPTIONS,
          { title: "New", optionIdentifier: "option-C" },
        ],
      },
    });
  });

  it("rejects metadata for another poll on cold lookup and refresh", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    get.mockResolvedValue(pollInfo({ pollMessageGuid: "another-poll" }));
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "voted", optionIdentifier: "option-A" }),
        PHONE
      )
    ).toEqual([]);
    expect(cache.get(POLL_GUID)).toBeUndefined();
    expect(cache.get("another-poll")).toBeUndefined();
    cachePollEvent(cache, snapshotEvent());
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "voted", optionIdentifier: "unknown" }),
        PHONE
      )
    ).toEqual([]);
    expect(cache.get("another-poll")).toBeUndefined();
    expect(cache.get(POLL_GUID)?.poll).toEqual(PUBLIC_POLL);
  });

  it("drops an option that remains unknown after refresh", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    cachePollEvent(cache, snapshotEvent());
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "unvoted", optionIdentifier: "missing" }),
        PHONE
      )
    ).toEqual([]);
    expect(get).toHaveBeenCalledExactlyOnceWith(POLL_GUID);
  });

  it("drops cold-cache and refresh failures without inventing metadata", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    get.mockRejectedValue(new Error("poll unavailable"));
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "voted", optionIdentifier: "option-A" }),
        PHONE
      )
    ).toEqual([]);
    cachePollEvent(cache, snapshotEvent());
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "voted", optionIdentifier: "new-option" }),
        PHONE
      )
    ).toEqual([]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not emit stale snapshots when an invalid current delta fails caching", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    cachePollEvent(cache, snapshotEvent());
    for (const type of SNAPSHOT_CASES) {
      for (const options of [
        [OPTIONS[0]],
        [{ text: "A" }, { text: "B" }],
        [
          { text: "A", optionIdentifier: "same" },
          { text: "B", optionIdentifier: "same" },
        ],
        [
          { text: "", optionIdentifier: "A" },
          { text: "B", optionIdentifier: "B" },
        ],
      ]) {
        expect(
          await toPollDeltaMessages(
            client,
            cache,
            pollEvent({ type, title: "", options }),
            PHONE
          )
        ).toEqual([]);
      }
    }
    expect(cache.get(POLL_GUID)?.poll).toEqual(PUBLIC_POLL);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects malformed polls returned by cold-cache lookup and unknown-option refresh", async () => {
    const { client, get } = makeClient();
    const cache = new PollCache();
    get.mockResolvedValue(
      pollInfo({ options: [{ text: "A" }, { text: "B" }] })
    );
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "voted", optionIdentifier: "option-A" }),
        PHONE
      )
    ).toEqual([]);
    expect(cache.get(POLL_GUID)).toBeUndefined();
    cachePollEvent(cache, snapshotEvent());
    expect(
      await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "voted", optionIdentifier: "unknown" }),
        PHONE
      )
    ).toEqual([]);
    expect(cache.get(POLL_GUID)?.poll).toEqual(PUBLIC_POLL);
  });

  it("emits the full added-option snapshot without inventing a vote and keeps sequence IDs distinct", async () => {
    const { client } = makeClient();
    const cache = new PollCache();
    cachePollEvent(cache, snapshotEvent());
    const options = [...OPTIONS, { optionIdentifier: "option-C", text: "New" }];
    for (const sequence of [8, 9]) {
      const messages = await toPollDeltaMessages(
        client,
        cache,
        pollEvent({ type: "optionAdded", title: "", options }, { sequence }),
        PHONE
      );
      expect(messages[0]?.id).toBe(`${POLL_GUID}:poll:${sequence}`);
      expect(messages[0]?.content).toEqual({
        ...PUBLIC_POLL,
        change: "optionAdded",
        options: [
          ...PUBLIC_OPTIONS,
          { title: "New", optionIdentifier: "option-C" },
        ],
      });
    }
  });
});
