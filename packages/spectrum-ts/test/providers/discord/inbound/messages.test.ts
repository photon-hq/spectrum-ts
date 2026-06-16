import { beforeEach, describe, expect, it, mock } from "bun:test";

// Poll-vote resolution fetches the poll message via the Discord client on a
// cache miss. Stub the client so the fetch path is deterministic and observable;
// the cache-hit path returns before this is ever called.
const getChannelMessageMock = mock(
  async (): Promise<{ poll?: unknown }> => ({ poll: undefined })
);
mock.module("@/providers/discord/client", () => ({
  discordClient: () => ({}),
  getChannelMessage: getChannelMessageMock,
}));

import type { ProviderMessageRecord } from "@/platform/types";
import { configSchema } from "@/providers/discord/config";
import { handleMessages } from "@/providers/discord/inbound/messages";
import { DispatchEvent } from "@/providers/discord/types";
import { createStore, type Store } from "@/utils/store";

// applicationId "999" is the bot's own id — drives the self-event filters.
const config = configSchema.parse({
  botToken: "abc.def.ghi",
  applicationId: "999",
});

// `handleMessages` is a Fusor handler; it reads `payload`, `config` and (for
// polls) `store`, so a minimal ctx (cast to the full ctx type) is enough.
const dispatch = (t: string, d: Record<string, unknown>, store?: Store) =>
  handleMessages({
    config,
    payload: { t, d },
    store,
  } as Parameters<typeof handleMessages>[0]);

// Synchronous dispatches (create/update/delete/reaction) return a record
// directly; poll votes resolve asynchronously. Two thin wrappers keep each
// call site's return type precise.
const handle = (t: string, d: Record<string, unknown>, store?: Store) =>
  dispatch(t, d, store) as ProviderMessageRecord | undefined;

const handleVote = (t: string, d: Record<string, unknown>, store?: Store) =>
  dispatch(t, d, store) as Promise<ProviderMessageRecord | undefined>;

// A Discord poll object as it appears on a message (gateway `poll` or REST
// `PollResponse`): a question plus answers carrying a stable `answer_id`.
const discordPoll = () => ({
  question: { text: "Lunch?" },
  answers: [
    { answer_id: 1, poll_media: { text: "Tacos" } },
    { answer_id: 2, poll_media: { text: "Sushi" } },
  ],
});

const votePayload = (over: Record<string, unknown> = {}) => ({
  channel_id: "100",
  message_id: "5",
  user_id: "7",
  answer_id: 2,
  ...over,
});

beforeEach(() => {
  getChannelMessageMock.mockReset();
  getChannelMessageMock.mockResolvedValue({ poll: undefined });
});

const reactionPayload = (over: Record<string, unknown> = {}) => ({
  channel_id: "100",
  message_id: "5",
  user_id: "7",
  emoji: { id: null, name: "👍" },
  ...over,
});

describe("handleMessages — MESSAGE_DELETE", () => {
  it("maps a delete to an unsend retracting the message", () => {
    const record = handle(DispatchEvent.MESSAGE_DELETE, {
      id: "5",
      channel_id: "100",
    });
    expect(record?.id).toBe("delete:100:5");
    expect(record?.space.id).toBe("100");
    expect(record?.content.type).toBe("unsend");
    if (record?.content.type === "unsend") {
      expect(record.content.target.id).toBe("5");
      expect(record.content.target.direction).toBe("inbound");
    }
  });
});

describe("handleMessages — MESSAGE_REACTION_REMOVE", () => {
  it("maps a reaction removal to an unsend targeting the reaction", () => {
    const record = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload()
    );
    expect(record?.id).toBe("reaction-remove:100:5:7:👍");
    expect(record?.sender?.id).toBe("7");
    expect(record?.space.id).toBe("100");
    expect(record?.content.type).toBe("unsend");
  });

  it("targets the same id the add handler synthesizes so they correlate", () => {
    const added = handle(DispatchEvent.MESSAGE_REACTION_ADD, reactionPayload());
    const removed = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload()
    );
    expect(added?.id).toBe("reaction:100:5:7:👍");
    expect(removed?.content.type).toBe("unsend");
    if (removed?.content.type === "unsend") {
      expect(removed.content.target.id).toBe("reaction:100:5:7:👍");
    }
  });

  it("ignores the bot's own reaction removals", () => {
    const record = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload({ user_id: "999" })
    );
    expect(record).toBeUndefined();
  });

  it("ignores custom emoji with no name", () => {
    const record = handle(
      DispatchEvent.MESSAGE_REACTION_REMOVE,
      reactionPayload({ emoji: { id: "123", name: null } })
    );
    expect(record).toBeUndefined();
  });
});

const pollMessagePayload = (over: Record<string, unknown> = {}) => ({
  id: "5",
  channel_id: "100",
  author: { id: "7", username: "ann" },
  content: "",
  attachments: [],
  timestamp: "2024-01-01T00:00:00.000Z",
  poll: discordPoll(),
  ...over,
});

describe("handleMessages — MESSAGE_CREATE poll", () => {
  it("surfaces a poll message as poll content", () => {
    const record = handle(DispatchEvent.MESSAGE_CREATE, pollMessagePayload());
    expect(record?.content.type).toBe("poll");
    if (record?.content.type === "poll") {
      expect(record.content.title).toBe("Lunch?");
      expect(record.content.options.map((o) => o.title)).toEqual([
        "Tacos",
        "Sushi",
      ]);
    }
  });

  it("drops a malformed poll (fewer than two options)", () => {
    const record = handle(
      DispatchEvent.MESSAGE_CREATE,
      pollMessagePayload({
        poll: {
          question: { text: "Lunch?" },
          answers: [{ answer_id: 1, poll_media: { text: "Tacos" } }],
        },
      })
    );
    expect(record).toBeUndefined();
  });
});

describe("handleMessages — poll votes", () => {
  it("maps an added vote to a selected poll_option (cache hit, no fetch)", async () => {
    const store = createStore();
    // A poll message caches the reconstruction, so the vote resolves without a
    // REST fetch.
    handle(DispatchEvent.MESSAGE_CREATE, pollMessagePayload(), store);

    const record = await handleVote(
      DispatchEvent.MESSAGE_POLL_VOTE_ADD,
      votePayload(),
      store
    );
    expect(getChannelMessageMock).not.toHaveBeenCalled();
    expect(record?.id).toBe("poll-vote-add:100:5:7:2");
    expect(record?.sender?.id).toBe("7");
    expect(record?.space.id).toBe("100");
    expect(record?.content.type).toBe("poll_option");
    if (record?.content.type === "poll_option") {
      expect(record.content.selected).toBe(true);
      expect(record.content.option.title).toBe("Sushi");
      expect(record.content.poll.title).toBe("Lunch?");
    }
  });

  it("maps a removed vote to an unselected poll_option with a distinct id", async () => {
    const store = createStore();
    handle(DispatchEvent.MESSAGE_CREATE, pollMessagePayload(), store);

    const record = await handleVote(
      DispatchEvent.MESSAGE_POLL_VOTE_REMOVE,
      votePayload(),
      store
    );
    expect(record?.id).toBe("poll-vote-remove:100:5:7:2");
    expect(record?.content.type).toBe("poll_option");
    if (record?.content.type === "poll_option") {
      expect(record.content.selected).toBe(false);
      expect(record.content.option.title).toBe("Sushi");
    }
  });

  it("ignores the bot's own votes", async () => {
    const store = createStore();
    handle(DispatchEvent.MESSAGE_CREATE, pollMessagePayload(), store);

    const record = await handleVote(
      DispatchEvent.MESSAGE_POLL_VOTE_ADD,
      votePayload({ user_id: "999" }),
      store
    );
    expect(record).toBeUndefined();
  });

  it("fetches the poll message on a cache miss, then caches it", async () => {
    getChannelMessageMock.mockResolvedValue({ poll: discordPoll() });
    const store = createStore();

    const first = await handleVote(
      DispatchEvent.MESSAGE_POLL_VOTE_ADD,
      votePayload(),
      store
    );
    expect(getChannelMessageMock).toHaveBeenCalledTimes(1);
    expect(first?.content.type).toBe("poll_option");

    // The fetch result is cached, so a sibling vote does not fetch again.
    await handleVote(DispatchEvent.MESSAGE_POLL_VOTE_ADD, votePayload(), store);
    expect(getChannelMessageMock).toHaveBeenCalledTimes(1);
  });
});
