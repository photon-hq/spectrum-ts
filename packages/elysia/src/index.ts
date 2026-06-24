// Spectrum webhook receiver as a first-party ElysiaJS plugin.
//
// Elysia's `parse` lifecycle auto-parses application/json bodies before the
// route handler runs, which consumes the `Request` body stream. That breaks
// Spectrum's HMAC verification, which is computed over the EXACT wire bytes
// (`HMAC-SHA256(secret, "v0:<ts>:<rawBody>")`) — once Elysia has read (and
// possibly re-encoded) the body, `app.webhook()` either throws "body already
// used" or verifies against the wrong bytes.
//
// Setting `parse: "none"` on the route makes Elysia skip body parsing entirely,
// leaving the raw `Request` untouched. We hand it straight to the Web-standard
// `app.webhook(request, handler)` overload and return the `Response` it produces
// unchanged — so this plugin is a thin transport adapter that inherits all of
// `app.webhook()`'s behavior (native + fusor detection, signature verification,
// fire-and-forget dispatch) for free.

import type { WebhookHandler } from "@spectrum-ts/core";
import { Elysia } from "elysia";

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
 * Mount a Spectrum webhook endpoint on an Elysia app.
 *
 * @example
 * ```ts
 * import { Elysia } from "elysia";
 * import { Spectrum } from "spectrum-ts";
 * import { spectrum } from "@spectrum-ts/elysia";
 *
 * const app = await Spectrum({ ...,  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET });
 *
 * new Elysia()
 *   .use(spectrum({
 *     app,
 *     onMessage: async (space, message) => {
 *       if (message.content.type === "text") await space.send(`echo: ${message.content.text}`);
 *     },
 *   }))
 *   .listen(3000);
 * ```
 */
export function spectrum(options: SpectrumPluginOptions) {
  const { app, onMessage, path = "/spectrum/webhook" } = options;

  // `seed: path` keeps the plugin dedupe-safe (Elysia collapses same-name +
  // same-seed instances) while still allowing distinct paths to coexist.
  return new Elysia({ name: "spectrum-webhook", seed: path }).post(
    path,
    ({ request }) => app.webhook(request, onMessage),
    { parse: "none" }
  );
}

export type { Message, Space, WebhookHandler } from "@spectrum-ts/core";
