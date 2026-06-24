// Spectrum webhook receiver as a first-party Hono plugin.
//
// Unlike Elysia, Hono needs no body-parsing workaround: it never auto-parses a
// request body, so `c.req.raw` is the EXACT, untouched Web `Request` — the body
// stream is only consumed if you call `c.req.json()` / `c.req.parseBody()`. That
// matters because Spectrum verifies the native webhook's HMAC over the exact wire
// bytes (`HMAC-SHA256(secret, "v0:<ts>:<rawBody>")`); re-encoding the body would
// break it. We hand `c.req.raw` straight to the Web-standard
// `app.webhook(request, handler)` overload and return the `Response` it produces
// unchanged — so this plugin is a thin transport adapter that inherits all of
// `app.webhook()`'s behavior (native + fusor detection, signature verification,
// fire-and-forget dispatch) for free.
//
// It returns a mountable Hono sub-app (Hono's "grouping" pattern), so a host app
// composes it with `app.route("/", spectrum(...))` — the direct analog of
// Elysia's `.use(spectrum(...))`.

import type { WebhookHandler } from "@spectrum-ts/core";
import { Hono } from "hono";

/**
 * The minimal structural surface of a Spectrum instance the plugin needs. Kept
 * structural (rather than importing the generic `SpectrumInstance<Providers>`)
 * so the plugin stays decoupled from provider typing; a real instance is
 * assignable via its Web `Request` webhook overload.
 */
interface WebhookReceiver {
  webhook(request: Request, handler: WebhookHandler): Promise<Response>;
}

export interface SpectrumPluginOptions {
  /** The Spectrum instance returned by `await Spectrum({...})`. */
  app: WebhookReceiver;
  /**
   * Invoked once per inbound message, fire-and-forget after the response — the
   * same `(space, message)` contract as `app.webhook(request, handler)`. Covers
   * both native Spectrum webhooks and fusor webhooks identically.
   */
  onMessage: WebhookHandler;
  /**
   * Route the webhook is mounted on.
   *
   * @default "/spectrum/webhook"
   */
  path?: string;
}

/**
 * Mount a Spectrum webhook endpoint on a Hono app.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { Spectrum } from "spectrum-ts";
 * import { spectrum } from "@spectrum-ts/hono";
 *
 * const app = await Spectrum({ ...,  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET });
 *
 * const server = new Hono().route("/", spectrum({
 *   app,
 *   onMessage: async (space, message) => {
 *     if (message.content.type === "text") await space.send(`echo: ${message.content.text}`);
 *   },
 * }));
 * ```
 */
export function spectrum(options: SpectrumPluginOptions) {
  const { app, onMessage, path = "/spectrum/webhook" } = options;

  return new Hono().post(path, (c) => app.webhook(c.req.raw, onMessage));
}

export type { Message, Space, WebhookHandler } from "@spectrum-ts/core";
