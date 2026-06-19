import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import {
  createLogger,
  errorAttrs,
  sanitizeErrorMessage,
} from "@spectrum-ts/core/authoring";
import { LRUCache } from "lru-cache";

const log = createLogger("spectrum.imessage.contact");

const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_CHATS = 10_000;

/**
 * Tracks which chats this bot has already proactively pushed its contact card
 * to, so `im.chats.shareContactInfo` is fired at most once per chat per 24h
 * per iMessage provider instance.
 *
 * Backed by `lru-cache` for TTL + bounded memory. `ttlAutopurge: false`
 * keeps eviction lazy (on access) — there is no background timer to leak
 * across Spectrum lifecycles.
 */
export class ContactShareTracker {
  private readonly cache = new LRUCache<string, true>({
    max: MAX_TRACKED_CHATS,
    ttl: SHARE_TTL_MS,
    ttlAutopurge: false,
  });

  /**
   * Best-effort share. The cache is set eagerly so that a burst of inbound
   * messages for the same chat coalesces to a single API call. On failure the
   * entry is evicted so the next inbound retries — transient errors don't
   * permanently mute the feature for a chat. Never awaits and never throws:
   * the receive stream must not crash on share failures.
   */
  maybeShare(client: AdvancedIMessage, chatGuid: string): void {
    if (this.cache.has(chatGuid)) {
      return;
    }
    this.cache.set(chatGuid, true);
    // chatGuid embeds the peer's phone/email for DMs — scrub it before logging.
    const safeChatGuid = sanitizeErrorMessage(chatGuid);
    client.chats
      .shareContactInfo(chatGuid)
      .then(() => {
        log.info("shared contact card", {
          "spectrum.imessage.contact.chat": safeChatGuid,
        });
      })
      .catch((error: unknown) => {
        this.cache.delete(chatGuid);
        log.warn(
          "failed to share contact card",
          {
            "spectrum.imessage.contact.chat": safeChatGuid,
            ...errorAttrs(error),
          },
          error
        );
      });
  }
}

const trackers = new WeakMap<object, ContactShareTracker>();

/**
 * Returns a per-owner tracker. Mirrors `getMessageCache`/`getPollCache` in
 * ../cache.ts — keyed by an object (the `RemoteClient[]` array for remote
 * mode), so each iMessage provider instance has its own tracker and multiple
 * providers don't share state accidentally.
 */
export const getContactShareTracker = (owner: object): ContactShareTracker => {
  let tracker = trackers.get(owner);
  if (!tracker) {
    tracker = new ContactShareTracker();
    trackers.set(owner, tracker);
  }
  return tracker;
};
