import { describe, expect, it, mock } from "bun:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { flush } from "@test/support/timing";
import {
  ContactShareTracker,
  getContactShareTracker,
} from "@/providers/imessage/remote/contact-share";

const makeClient = (
  share: (chatGuid: string) => Promise<void>
): AdvancedIMessage =>
  ({
    chats: { shareContactInfo: share },
  }) as unknown as AdvancedIMessage;

describe("ContactShareTracker", () => {
  it("shares once per chat across repeated inbound messages", async () => {
    const share = mock((_: string) => Promise.resolve());
    const client = makeClient(share);
    const tracker = new ContactShareTracker();

    tracker.maybeShare(client, "chat-A");
    tracker.maybeShare(client, "chat-A");
    tracker.maybeShare(client, "chat-A");
    await flush();

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith("chat-A");
  });

  it("coalesces a burst of concurrent inbound messages to one API call", async () => {
    let resolveShare!: () => void;
    const sharePromise = new Promise<void>((r) => {
      resolveShare = r;
    });
    const share = mock((_: string) => sharePromise);
    const client = makeClient(share);
    const tracker = new ContactShareTracker();

    // Five concurrent inbound messages for the same chat — only the first
    // should kick off the share; the rest should see the cached entry and
    // skip even though the in-flight promise hasn't resolved yet.
    for (let i = 0; i < 5; i++) {
      tracker.maybeShare(client, "chat-burst");
    }
    expect(share).toHaveBeenCalledTimes(1);

    resolveShare();
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("shares for distinct chats independently", async () => {
    const share = mock((_: string) => Promise.resolve());
    const client = makeClient(share);
    const tracker = new ContactShareTracker();

    tracker.maybeShare(client, "chat-A");
    tracker.maybeShare(client, "chat-B");
    tracker.maybeShare(client, "chat-A");
    await flush();

    expect(share).toHaveBeenCalledTimes(2);
    expect(share.mock.calls.map((c) => c[0]).sort()).toEqual([
      "chat-A",
      "chat-B",
    ]);
  });

  it("retries on the next inbound when a share fails", async () => {
    let attempt = 0;
    const share = mock((_: string) => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve();
    });
    const client = makeClient(share);
    const tracker = new ContactShareTracker();

    tracker.maybeShare(client, "chat-retry");
    await flush();
    expect(share).toHaveBeenCalledTimes(1);

    // After failure the cache entry should be evicted, so the next inbound
    // tries again rather than silently muting the chat.
    tracker.maybeShare(client, "chat-retry");
    await flush();
    expect(share).toHaveBeenCalledTimes(2);

    // The retry succeeded — subsequent inbounds within the window are deduped.
    tracker.maybeShare(client, "chat-retry");
    await flush();
    expect(share).toHaveBeenCalledTimes(2);
  });

  it("never throws synchronously even when shareContactInfo rejects", async () => {
    const share = mock((_: string) => Promise.reject(new Error("boom")));
    const client = makeClient(share);
    const tracker = new ContactShareTracker();

    expect(() => tracker.maybeShare(client, "chat-throw")).not.toThrow();
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
  });
});

describe("getContactShareTracker", () => {
  it("returns the same tracker for the same owner", () => {
    const owner = {};
    const a = getContactShareTracker(owner);
    const b = getContactShareTracker(owner);
    expect(a).toBe(b);
  });

  it("returns distinct trackers for distinct owners", () => {
    const a = getContactShareTracker({});
    const b = getContactShareTracker({});
    expect(a).not.toBe(b);
  });
});
