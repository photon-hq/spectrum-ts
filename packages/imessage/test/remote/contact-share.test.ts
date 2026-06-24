import { describe, expect, it, mock } from "bun:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { flush } from "@spectrum-ts/test-support/timing";
import {
  ContactShareTracker,
  getContactShareTracker,
} from "@/remote/contact-share";

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
    const tracker = new ContactShareTracker(client);

    tracker.maybeShare("chat-A");
    tracker.maybeShare("chat-A");
    tracker.maybeShare("chat-A");
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
    const tracker = new ContactShareTracker(client);

    // Five concurrent inbound messages for the same chat — only the first
    // should kick off the share; the rest should see the cached entry and
    // skip even though the in-flight promise hasn't resolved yet.
    for (let i = 0; i < 5; i++) {
      tracker.maybeShare("chat-burst");
    }
    expect(share).toHaveBeenCalledTimes(1);

    resolveShare();
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("shares for distinct chats independently", async () => {
    const share = mock((_: string) => Promise.resolve());
    const client = makeClient(share);
    const tracker = new ContactShareTracker(client);

    tracker.maybeShare("chat-A");
    tracker.maybeShare("chat-B");
    tracker.maybeShare("chat-A");
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
    const tracker = new ContactShareTracker(client);

    tracker.maybeShare("chat-retry");
    await flush();
    expect(share).toHaveBeenCalledTimes(1);

    // After failure the cache entry should be evicted, so the next inbound
    // tries again rather than silently muting the chat.
    tracker.maybeShare("chat-retry");
    await flush();
    expect(share).toHaveBeenCalledTimes(2);

    // The retry succeeded — subsequent inbounds within the window are deduped.
    tracker.maybeShare("chat-retry");
    await flush();
    expect(share).toHaveBeenCalledTimes(2);
  });

  it("never throws synchronously even when shareContactInfo rejects", async () => {
    const share = mock((_: string) => Promise.reject(new Error("boom")));
    const client = makeClient(share);
    const tracker = new ContactShareTracker(client);

    expect(() => tracker.maybeShare("chat-throw")).not.toThrow();
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
  });
});

describe("getContactShareTracker", () => {
  const noopClient = () => makeClient(() => Promise.resolve());

  it("returns the same tracker for the same client", () => {
    const client = noopClient();
    const a = getContactShareTracker(client);
    const b = getContactShareTracker(client);
    expect(a).toBe(b);
  });

  it("returns distinct trackers for distinct clients", () => {
    const a = getContactShareTracker(noopClient());
    const b = getContactShareTracker(noopClient());
    expect(a).not.toBe(b);
  });

  it("shares per line — distinct clients dedupe the same chat independently", async () => {
    const shareA = mock((_: string) => Promise.resolve());
    const shareB = mock((_: string) => Promise.resolve());
    const trackerA = getContactShareTracker(makeClient(shareA));
    const trackerB = getContactShareTracker(makeClient(shareB));

    // Same DM chat guid (encodes the peer) arriving on two different lines.
    trackerA.maybeShare("any;-;+15550123");
    trackerB.maybeShare("any;-;+15550123");
    trackerA.maybeShare("any;-;+15550123"); // dup on line A — deduped
    await flush();

    expect(shareA).toHaveBeenCalledTimes(1);
    expect(shareB).toHaveBeenCalledTimes(1);
  });
});
