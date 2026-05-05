import { createHmac, timingSafeEqual } from "node:crypto";
import type { SpectrumLike } from "../platform/types";
import type { Store } from "./store";

/**
 * Webhook utilities shared across providers.
 *
 * Two layers live here:
 *
 * 1. **Provider-agnostic primitives** — `InboundQueue<T>` /
 *    `makeInboundQueue<T>()` and `createWebhookStateSlot()`. Every
 *    webhook-capable provider uses these to bridge an HTTP handler into
 *    the platform's `events.messages` async iterable, without each
 *    provider re-implementing the queue or the `Store` lookup.
 *
 * 2. **Meta-family helpers** — `verifyMetaSignature` and
 *    `handleMetaChallenge`. Reused by providers whose platforms speak
 *    Meta's webhook format (WhatsApp Business today; Instagram and
 *    Facebook Messenger when they ship). Slack/Telegram/Stripe families
 *    add their own sibling helpers when those providers are added.
 *
 * The handlers are deliberately request/response-oriented (Web Fetch
 * `Request`/`Response`) so providers can return handlers that mount in
 * any HTTP framework (Hono, Express, Bun.serve, Cloudflare Workers, etc).
 */

// ---------------------------------------------------------------------------
// Generic primitive: buffered async queue
// ---------------------------------------------------------------------------

export interface InboundQueue<T> {
  close(): void;
  iterable: AsyncIterable<T>;
  push(message: T): void;
}

/**
 * Buffered async queue. Producer never blocks; consumer's `for-await`
 * resolves as items arrive. Used by webhook-mode providers to bridge
 * HTTP requests into `events.messages` without losing messages that
 * arrive before the agent's loop starts iterating.
 */
export const makeInboundQueue = <T>(): InboundQueue<T> => {
  const buffered: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const drain = () => {
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined as never, done: true });
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (closed && buffered.length === 0) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          const next = buffered.shift();
          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<T>> {
          closed = true;
          drain();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(message) {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: message, done: false });
        return;
      }
      buffered.push(message);
    },
    close() {
      closed = true;
      drain();
    },
  };
};

// ---------------------------------------------------------------------------
// Generic primitive: per-platform webhook state slot on `Store`
// ---------------------------------------------------------------------------

/**
 * Common shape for webhook state. Each provider extends this with whatever
 * verification material it needs (HMAC secret, verify token, signing
 * secret, timestamp window, etc).
 */
export interface WebhookStateBase<TMessage> {
  inbound: InboundQueue<TMessage>;
}

export interface WebhookStateSlot<TState extends WebhookStateBase<unknown>> {
  /** Idempotent — preserves the existing state if the slot is already set. */
  init(store: Store, state: TState): void;
  /** Read directly from a `Store` (used inside provider lifecycle/events). */
  read(store: Store): TState;
  /** Read via the Spectrum runtime (used by user-facing `webhook(spectrum)`). */
  readFromSpectrum(spectrum: SpectrumLike): TState;
}

export interface CreateWebhookSlotOptions<TState> {
  isState: (value: unknown) => value is TState;
  /** User-facing message thrown when reads happen before init. */
  notConfiguredMessage?: string;
  platformName: string;
  storeKey: string;
}

/**
 * Encapsulates the per-platform `Store` slot machinery: the storage key,
 * the runtime lookup, and the type-guarded read. Each provider creates
 * one of these once at module scope and reuses it from `lifecycle`,
 * `events.messages`, and the user-facing webhook accessor.
 */
export const createWebhookStateSlot = <
  TState extends WebhookStateBase<unknown>,
>(
  opts: CreateWebhookSlotOptions<TState>
): WebhookStateSlot<TState> => {
  const notConfigured =
    opts.notConfiguredMessage ??
    `Platform "${opts.platformName}" is not configured for webhook ingress.`;

  const init = (store: Store, state: TState): void => {
    if (store.has(opts.storeKey)) {
      return;
    }
    store.set(opts.storeKey, state);
  };

  const read = (store: Store): TState => {
    const value = store.get(opts.storeKey);
    if (!opts.isState(value)) {
      throw new Error(notConfigured);
    }
    return value;
  };

  const readFromSpectrum = (spectrum: SpectrumLike): TState => {
    const runtime = spectrum.__internal.platforms.get(opts.platformName);
    if (!runtime) {
      throw new Error(`Platform "${opts.platformName}" is not registered`);
    }
    return read(runtime.store);
  };

  return { init, read, readFromSpectrum };
};

// ---------------------------------------------------------------------------
// Meta-family helpers (WhatsApp Business, Instagram, Facebook Messenger)
// ---------------------------------------------------------------------------

const META_SIGNATURE_PREFIX = "sha256=";

/**
 * Constant-time HMAC-SHA256 verification of a Meta-shaped webhook signature.
 * Returns false on missing header, malformed prefix, length mismatch, or
 * digest mismatch. Never throws.
 *
 * The HMAC is computed over the raw request body — any middleware that
 * re-serializes the JSON before this runs will silently invalidate the
 * signature, so callers must pass the original bytes.
 */
export const verifyMetaSignature = (
  rawBody: Buffer,
  signatureHeader: string | null,
  appSecret: string
): boolean => {
  if (!signatureHeader?.startsWith(META_SIGNATURE_PREFIX)) {
    return false;
  }
  const providedHex = signatureHeader.slice(META_SIGNATURE_PREFIX.length);
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
};

/**
 * Handle Meta's one-time GET verification handshake. Echoes `hub.challenge`
 * with 200 when `hub.mode=subscribe` and `hub.verify_token` matches.
 * Returns 400 on a missing/malformed challenge, 403 on token mismatch.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export const handleMetaChallenge = (
  req: Request,
  verifyToken: string
): Response => {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || token === null || challenge === null) {
    return new Response("Bad Request", { status: 400 });
  }
  if (token !== verifyToken) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
};

export const META_HUB_SIGNATURE_HEADER = "x-hub-signature-256";
