# Fastify plugin

`@spectrum-ts/fastify` is a first-party [Fastify](https://fastify.dev) plugin that
mounts a Spectrum webhook endpoint in a single `.register()`. It wraps
[`app.webhook()`](./fusor.md#webhook-mode--appwebhook), so it handles **both**
webhook formats — the [native Spectrum webhook](./native-webhook.md) (HMAC-signed
JSON) and the [Fusor webhook](./fusor.md) (protobuf) — and hands your `onMessage`
the same `(space, message)` either way.

## Why a plugin (and not just a route)

Fastify auto-parses known content types (e.g. `application/json`) before your
route handler runs, which consumes and re-encodes the request body. That breaks
Spectrum's HMAC verification, which is computed over the **exact wire bytes**
(`HMAC-SHA256(secret, "v0:<ts>:<rawBody>")`) — once Fastify has parsed the body,
verification runs against the wrong bytes (and a fusor protobuf body fails to
decode entirely).

The plugin fixes this in an **encapsulated** scope: inside its own plugin
context it removes the inherited content-type parsers and registers a wildcard
parser that captures the raw bytes as a `Buffer`, then hands them to
`app.webhook()` and writes the result back onto the reply:

```ts
fastify.removeAllContentTypeParsers();
fastify.addContentTypeParser("*", (_req, payload, done) => {
  const chunks: Uint8Array[] = [];
  payload.on("data", (chunk) => chunks.push(chunk));
  payload.on("end", () => done(null, Buffer.concat(chunks)));
  payload.on("error", done);
});
fastify.post(path, async (request, reply) => {
  const result = await app.webhook(
    { body: request.body as Buffer, headers: request.headers },
    onMessage
  );
  return reply.status(result.status).headers(result.headers).send(Buffer.from(result.body));
});
```

Because Fastify scopes parsers per encapsulation context, this wildcard parser
applies **only** to the plugin's route — your other routes keep their normal
JSON parsing, and the plugin keeps its raw bytes. The plugin owns all of that
behind one `server.register(spectrum, ...)`.

## Install

```bash
bun add spectrum-ts @spectrum-ts/fastify fastify
```

`spectrum-ts` provides `Spectrum` (and your providers); `@spectrum-ts/fastify` is
the plugin; `fastify` is its required peer dependency. (Using `@spectrum-ts/core`
directly instead of the metapackage? Swap it in for `spectrum-ts`.)

## Usage

```ts
import Fastify from "fastify";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spectrum } from "@spectrum-ts/fastify";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config()],
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET, // for native webhooks
});

const server = Fastify();

server.register(spectrum, {
  app,
  onMessage: async (space, message) => {
    if (message.content.type === "text") {
      await space.send(`echo: ${message.content.text}`);
    }
  },
});

// Await listen so a startup failure surfaces instead of going unhandled.
await server.listen({ port: 3000 });
```

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `app` | `Spectrum` instance | — | The instance returned by `await Spectrum({...})`. |
| `onMessage` | `(space, message) => void \| Promise<void>` | — | Invoked once per inbound message, **fire-and-forget** after the response (a throw is logged, never surfaced). Dedupe on `message.id` for exactly-once side effects. |
| `path` | `string` | `"/spectrum/webhook"` | Route the endpoint is mounted on. |

`spectrum` is an async Fastify plugin, so a Fastify register prefix stacks on top
of `path` — `server.register(spectrum, { app, onMessage, prefix: "/hooks" })`
serves `POST /hooks/spectrum/webhook`. Prefer setting `path` for a single,
explicit endpoint.

Everything else — signature verification, native-vs-fusor detection,
deserialization, attachment rehydration, status codes, and at-least-once retry
semantics — is exactly [what `app.webhook()` does](./native-webhook.md#what-the-sdk-does-for-you).

## Reference

- Plugin source — `@spectrum-ts/fastify` (`packages/fastify/src/index.ts`)
- `app.webhook(request, handler)` — `@spectrum-ts/core` (`packages/core/src/spectrum.ts`)
