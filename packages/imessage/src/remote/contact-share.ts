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
 * Tracks which chats this bot's line has already proactively pushed its contact
 * card to, so `im.chats.shareContactInfo` is fired at most once per chat per
 * line per 24h. One tracker is created per `AdvancedIMessage` client (see
 * `getContactShareTracker`), so the dedupe is naturally scoped to the line: a
 * DM `chatGuid` encodes the peer, not the receiving bot line, so the same guid
 * arriving on a different line shares independently.
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

  private readonly client: AdvancedIMessage;

  constructor(client: AdvancedIMessage) {
    this.client = client;
  }

  /**
   * Best-effort share. The cache is set eagerly so that a burst of inbound
   * messages for the same chat coalesces to a single API call. On failure the
   * entry is evicted so the next inbound retries — transient errors don't
   * permanently mute the feature for a chat. Never awaits and never throws:
   * the receive stream must not crash on share failures.
   */
  maybeShare(chatGuid: string): void {
    if (this.cache.has(chatGuid)) {
      return;
    }
    this.cache.set(chatGuid, true);
    // chatGuid embeds the peer's phone/email for DMs — scrub it before logging.
    const safeChatGuid = sanitizeErrorMessage(chatGuid);
    this.client.chats
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

const trackers = new WeakMap<AdvancedIMessage, ContactShareTracker>();

/**
 * Returns a per-line tracker. Mirrors `getMessageCache` in ../cache.ts — keyed
 * by the individual `AdvancedIMessage` client, so each line has its own dedupe
 * state and multiple lines/providers don't share state accidentally. The
 * WeakMap holds the client weakly, so a torn-down line's tracker is collected
 * with its client (the tracker's own reference back to the client doesn't pin
 * it — the entry is a collectible cycle).
 */
export const getContactShareTracker = (
  client: AdvancedIMessage
): ContactShareTracker => {
  let tracker = trackers.get(client);
  if (!tracker) {
    tracker = new ContactShareTracker(client);
    trackers.set(client, tracker);
  }
  return tracker;
};
