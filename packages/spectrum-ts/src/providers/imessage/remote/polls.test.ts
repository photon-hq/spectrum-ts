import { describe, expect, it } from "bun:test";
import type { PollEvent, PollOption } from "@photon-ai/advanced-imessage";
import { PollCache } from "../cache";
import { cachePollEvent } from "./polls";

const option = (text: string, optionIdentifier: string): PollOption => ({
  text,
  optionIdentifier,
});

const createdEvent = (
  overrides: Partial<{
    title: string;
    options: readonly PollOption[];
    pollMessageGuid: string;
  }> = {}
): PollEvent => ({
  type: "poll.changed",
  chatGuid: "iMessage;-;chat-1",
  pollMessageGuid: overrides.pollMessageGuid ?? "poll-msg-1",
  sequence: 1,
  occurredAt: new Date("2025-01-01T00:00:00Z"),
  isFromMe: false,
  delta: {
    type: "created",
    title: overrides.title ?? "Lunch?",
    options: overrides.options ?? [
      option("Pizza", "opt-1"),
      option("Burgers", "opt-2"),
    ],
  },
});

const optionAddedEvent = (title: string): PollEvent => ({
  type: "poll.changed",
  chatGuid: "iMessage;-;chat-1",
  pollMessageGuid: "poll-msg-2",
  sequence: 2,
  occurredAt: new Date("2025-01-01T00:00:01Z"),
  isFromMe: false,
  delta: {
    type: "optionAdded",
    title,
    options: [
      option("Pizza", "opt-1"),
      option("Burgers", "opt-2"),
      option("Salad", "opt-3"),
    ],
  },
});

describe("cachePollEvent", () => {
  it("caches a created poll with a normal title", () => {
    const cache = new PollCache();
    const cached = cachePollEvent(cache, createdEvent({ title: "Lunch?" }));
    expect(cached).toBeDefined();
    expect(cached?.poll.title).toBe("Lunch?");
    expect(cached?.poll.options).toHaveLength(2);
    expect(cache.get("poll-msg-1")).toBeDefined();
  });

  // Regression: real iMessage polls with empty titles were being silently
  // dropped by the inbound parser. The fix relaxes pollSchema.title to
  // accept "" (and undefined) so these polls now cache successfully.
  it("caches a created poll whose delta carries an empty title", () => {
    const cache = new PollCache();
    const cached = cachePollEvent(cache, createdEvent({ title: "" }));
    if (!cached) {
      throw new Error("expected cachePollEvent to return a cached poll");
    }
    expect(cached.poll.title).toBe("");
    expect(cached.poll.options).toHaveLength(2);
    expect(cache.get("poll-msg-1")).toBe(cached);
  });

  it("caches an optionAdded delta with an empty title", () => {
    const cache = new PollCache();
    const cached = cachePollEvent(cache, optionAddedEvent(""));
    if (!cached) {
      throw new Error("expected cachePollEvent to return a cached poll");
    }
    expect(cached.poll.title).toBe("");
    expect(cached.poll.options).toHaveLength(3);
    expect(cache.get("poll-msg-2")).toBe(cached);
  });

  it("caches a created poll even when an option text is empty", () => {
    const cache = new PollCache();
    const cached = cachePollEvent(
      cache,
      createdEvent({
        title: "Pick one",
        options: [option("", "opt-1"), option("Burgers", "opt-2")],
      })
    );
    expect(cached).toBeDefined();
    expect(cached?.poll.options).toHaveLength(2);
    expect(cached?.poll.options[0]?.title).toBe("");
    expect(cached?.poll.options[1]?.title).toBe("Burgers");
  });

  it("returns undefined for voted/unvoted deltas (no cache write)", () => {
    const cache = new PollCache();
    const votedEvent: PollEvent = {
      type: "poll.changed",
      chatGuid: "iMessage;-;chat-1",
      pollMessageGuid: "poll-msg-3",
      sequence: 3,
      occurredAt: new Date(),
      isFromMe: false,
      delta: { type: "voted", optionIdentifier: "opt-1" },
    };
    expect(cachePollEvent(cache, votedEvent)).toBeUndefined();
    expect(cache.get("poll-msg-3")).toBeUndefined();
  });
});
