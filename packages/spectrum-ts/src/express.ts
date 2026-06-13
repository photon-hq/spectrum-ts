// Spectrum webhook receiver as a first-party Express plugin.
//
// Express runs on Node `req`/`res`, not the Web `Request`/`Response`, so this
// plugin uses `app.webhook()`'s raw overload (`{ body, headers }` →
// `{ status, headers, body }`) and writes the result back itself. The raw body
// bytes only exist if a body parser captures them as a Buffer, so the plugin
// mounts `express.raw({ type: "*/*" })` on its own route — Spectrum verifies the
// native webhook's HMAC over the EXACT wire bytes
// (`HMAC-SHA256(secret, "v0:<ts>:<rawBody>")`), so a parsed-and-re-encoded body
// would break verification (and the fusor protobuf body would fail to decode).
//
// ⚠️ Ordering hazard (the Express analog of Elysia's parse lifecycle): a global
// `express.json()` mounted BEFORE this router consumes the request stream first,
// leaving `req.body` a parsed object rather than the raw bytes — verification
// then fails. Mount this plugin before any global `express.json()`, or scope
// `json()` so it never matches the webhook path.
//
// It returns an Express `Router`, so a host app composes it with one
// `app.use(spectrum(...))` — the route, the raw-body parser, and the response
// writing are all owned by the plugin.

import express, { type Router } from "express";
import type { WebhookHandler } from "./fusor";

/**
 * The minimal structural surface of a Spectrum instance the plugin needs. Kept
 * structural (rather than importing the generic `SpectrumInstance<Providers>`)
 * so the plugin stays decoupled from provider typing; a real instance is
 * assignable via its raw (`{ body, headers }`) webhook overload.
 */
interface WebhookReceiver {
  webhook(
    request: {
      body: Uint8Array | ArrayBuffer;
      headers?: Record<string, string>;
    },
    handler: WebhookHandler
  ): Promise<{
    body: Uint8Array;
    headers: Record<string, string>;
    status: number;
  }>;
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
 * Mount a Spectrum webhook endpoint on an Express app.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { Spectrum } from "spectrum-ts";
 * import { spectrum } from "spectrum-ts/express";
 *
 * const app = await Spectrum({ ...,  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET });
 *
 * const server = express();
 * server.use(spectrum({ // mount before any global express.json()
 *   app,
 *   onMessage: async (space, message) => {
 *     if (message.content.type === "text") await space.send(`echo: ${message.content.text}`);
 *   },
 * }));
 * server.listen(3000);
 * ```
 */
export function spectrum(options: SpectrumPluginOptions): Router {
  const { app, onMessage, path = "/spectrum/webhook" } = options;

  const router = express.Router();
  router.post(path, express.raw({ type: "*/*" }), async (req, res) => {
    const result = await app.webhook(
      { body: req.body, headers: req.headers as Record<string, string> },
      onMessage
    );
    res
      .status(result.status)
      .set(result.headers)
      .send(Buffer.from(result.body));
  });
  return router;
}

export type { WebhookHandler } from "./fusor";
export type { Message } from "./types/message";
export type { Space } from "./types/space";
