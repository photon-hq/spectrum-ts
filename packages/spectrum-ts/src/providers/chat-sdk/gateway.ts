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
// Pause before reopening when a window did no work (or errored), so a flapping
// or idle gateway doesn't turn into a hot reconnect loop.
const GATEWAY_BACKOFF_MS = 1000;

const hasGateway = (adapter: unknown): adapter is ChatGatewayAdapter =>
  typeof (adapter as ChatGatewayAdapter | undefined)?.startGatewayListener ===
  "function";

const backoff = () =>
  new Promise((resolve) => setTimeout(resolve, GATEWAY_BACKOFF_MS));

// Keep one adapter's gateway continuously alive until `signal` aborts. The
// listen window runs in the promise(s) handed to `waitUntil`; we await those,
// then reopen. If a window scheduled nothing (or threw), back off first so a
// disconnected gateway doesn't spin.
const pumpOne = async (adapter: ChatGatewayAdapter, signal: AbortSignal) => {
  while (!signal.aborted) {
    const inflight: Promise<unknown>[] = [];
    try {
      await adapter.startGatewayListener(
        { waitUntil: (promise) => inflight.push(Promise.resolve(promise)) },
        GATEWAY_WINDOW_MS,
        signal
      );
      await Promise.allSettled(inflight);
      if (inflight.length === 0) {
        await backoff();
      }
    } catch {
      await backoff();
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
