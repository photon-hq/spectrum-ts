// Gateway pump: some platforms (Discord) deliver regular messages over a
// Gateway WebSocket rather than the interactions/HTTP webhook. Such adapters
// expose `startGatewayListener`, which opens the socket, holds it for a window,
// then resolves. The provider feature-detects this and keeps reopening it in a
// loop so a long-running worker maintains a continuously live socket. In
// direct-processing mode (no webhookUrl) the adapter dispatches gateway
// messages/reactions straight to the bot's handlers, which `registerInbound`
// has wired to the queue. Generic by capability, not by platform — any adapter
// exposing `startGatewayListener` gets pumped.

import type { ChatBot, ChatGatewayAdapter } from "./types";

// How long each `startGatewayListener` window stays open before we reopen it.
const GATEWAY_WINDOW_MS = 180_000;
// A window that winds down faster than this didn't really hold the socket — the
// gateway flapped or resolved instantly — so we back off before reopening.
const GATEWAY_MIN_WINDOW_MS = 1000;
// Backoff grows from min to max across consecutive flaps so a persistently
// disconnected gateway settles into slow polling instead of a hot loop; a
// healthy full-length window resets it.
const GATEWAY_BACKOFF_MIN_MS = 1000;
const GATEWAY_BACKOFF_MAX_MS = 30_000;

const hasGateway = (adapter: unknown): adapter is ChatGatewayAdapter =>
  typeof (adapter as ChatGatewayAdapter | undefined)?.startGatewayListener ===
  "function";

const backoff = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Keep one adapter's gateway continuously alive until `signal` aborts. The
// listen window runs in the promise(s) handed to `waitUntil`; we await those,
// then reopen. We gate the reopen on how long the window actually held the
// socket, not on whether it scheduled anything — a flapping adapter can resolve
// `waitUntil` instantly, so counting inflight promises wouldn't catch it. Any
// window shorter than the floor backs off (escalating); a healthy one reopens
// at once and resets the backoff.
const pumpOne = async (adapter: ChatGatewayAdapter, signal: AbortSignal) => {
  let backoffMs = GATEWAY_BACKOFF_MIN_MS;
  while (!signal.aborted) {
    const startedAt = Date.now();
    const inflight: Promise<unknown>[] = [];
    try {
      await adapter.startGatewayListener(
        { waitUntil: (promise) => inflight.push(Promise.resolve(promise)) },
        GATEWAY_WINDOW_MS,
        signal
      );
      await Promise.allSettled(inflight);
    } catch {
      // Treated like any short window below — measured, then backed off.
    }
    if (signal.aborted) {
      break;
    }
    if (Date.now() - startedAt < GATEWAY_MIN_WINDOW_MS) {
      await backoff(backoffMs);
      backoffMs = Math.min(backoffMs * 2, GATEWAY_BACKOFF_MAX_MS);
    } else {
      backoffMs = GATEWAY_BACKOFF_MIN_MS;
    }
  }
};

/**
 * Start pumping every gateway-capable adapter on the bot. Resolves once `signal`
 * aborts and all pumps wind down. Safe to call un-awaited — failures stay on the
 * returned promise rather than throwing into the caller.
 */
export const startGatewayPump = async (
  bot: ChatBot,
  signal: AbortSignal
): Promise<void> => {
  const adapters = Object.keys(bot.webhooks)
    .map((slug) => bot.getAdapter?.(slug))
    .filter(hasGateway);

  await Promise.all(adapters.map((adapter) => pumpOne(adapter, signal)));
};
