// Spectrum webhook receiver as a first-party Fastify plugin.
//
// Fastify runs on its own Request/Reply abstraction model. This plugin
// registers a custom content type parser for `*` (all content types) to capture
// the raw request body payload bytes as a `Buffer`.
//
// ⚠️ Encapsulation: Registering the content type parser inside this plugin scope
// ensures it only applies to this route, preventing interference with global parsers.
//
// It returns an async Fastify plugin function.

import type { FastifyInstance } from "fastify";
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
 * Mount a Spectrum webhook endpoint on a Fastify app.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { Spectrum } from "spectrum-ts";
 * import { spectrum } from "spectrum-ts/fastify";
 *
 * const app = await Spectrum({ ...,  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET });
 *
 * const server = Fastify();
 * server.register(spectrum, {
 *   app,
 *   onMessage: async (space, message) => {
 *     if (message.content.type === "text") await space.send(`echo: ${message.content.text}`);
 *   },
 * });
 * server.listen({ port: 3000 });
 * ```
 */
export async function spectrum(
  fastify: FastifyInstance,
  options: SpectrumPluginOptions
) {
  const { app, onMessage, path = "/spectrum/webhook" } = options;

  // Remove default/global content type parsers inside this plugin's scope
  // to ensure they don't override our wildcard/raw body parser.
  fastify.removeAllContentTypeParsers();

  // Custom parser to capture the exact raw body bytes as a Buffer.
  // Using "*" captures all content types (application/json, application/x-protobuf, etc.)
  // under the scope of this plugin.
  fastify.addContentTypeParser("*", (_request, payload, done) => {
    const chunks: Uint8Array[] = [];
    payload.on("data", (chunk) => {
      chunks.push(chunk);
    });
    payload.on("end", () => {
      done(null, Buffer.concat(chunks));
    });
    payload.on("error", (err) => {
      done(err);
    });
  });

  fastify.post(path, async (request, reply) => {
    const result = await app.webhook(
      {
        body: request.body as Buffer,
        headers: normalizeHeaders(request.headers),
      },
      onMessage
    );

    return reply
      .status(result.status)
      .headers(result.headers)
      .send(Buffer.from(result.body));
  });
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[key] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return normalized;
}

export type { WebhookHandler } from "./fusor";
export type { Message } from "./types/message";
export type { Space } from "./types/space";
