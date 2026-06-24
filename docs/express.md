# Express plugin

`@spectrum-ts/express` is a first-party [Express](https://expressjs.com) plugin
that mounts a Spectrum webhook endpoint in a single `.use()`. It wraps
[`app.webhook()`](./fusor.md#webhook-mode--appwebhook), so it handles **both**
webhook formats — the [native Spectrum webhook](./native-webhook.md) (HMAC-signed
JSON) and the [Fusor webhook](./fusor.md) (protobuf) — and hands your `onMessage`
the same `(space, message)` either way.

## Why a plugin (and not just a route)

Express runs on Node `req`/`res`, not the Web `Request`/`Response`, so wiring the
webhook by hand means three fiddly things: reach for `app.webhook()`'s raw
overload, capture the body as bytes with `express.raw(...)` (Spectrum verifies the
HMAC over the **exact wire bytes**, so a parsed-and-re-encoded body breaks
verification), and write the result back onto `res` yourself:

```ts
app.post(
  "/spectrum/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const result = await app.webhook(
      { body: req.body, headers: req.headers },
      onMessage
    );
    res.status(result.status).set(result.headers).send(Buffer.from(result.body));
  }
);
```

The plugin owns all of that — the route, the `express.raw` parser, and the
response writing — behind one `app.use()`.

> ⚠️ **Mount it before any global `express.json()`.** A global JSON parser runs on
> every request and consumes the body stream first, so by the time the plugin's
> `express.raw` runs, `req.body` is a parsed object, not the raw bytes — and
> signature verification fails. Either mount `spectrum(...)` before
> `express.json()` (as below), or scope `express.json()` so it never matches the
> webhook path.

## Install

```bash
bun add spectrum-ts @spectrum-ts/express express
```

`spectrum-ts` provides `Spectrum` (and your providers); `@spectrum-ts/express` is
the plugin; `express` is its required peer dependency. (Using `@spectrum-ts/core`
directly instead of the metapackage? Swap it in for `spectrum-ts`.)

## Usage

```ts
import express from "express";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spectrum } from "@spectrum-ts/express";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config()],
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET, // for native webhooks
});

const server = express();

server.use(
  // Mount before any global express.json().
  spectrum({
    app,
    onMessage: async (space, message) => {
      if (message.content.type === "text") {
        await space.send(`echo: ${message.content.text}`);
      }
    },
  })
);

server.use(express.json()); // your other routes can parse JSON freely
server.listen(3000);
```

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `app` | `Spectrum` instance | — | The instance returned by `await Spectrum({...})`. |
| `onMessage` | `(space, message) => void \| Promise<void>` | — | Invoked once per inbound message, **fire-and-forget** after the response (a throw is logged, never surfaced). Dedupe on `message.id` for exactly-once side effects. |
| `path` | `string` | `"/spectrum/webhook"` | Route the endpoint is mounted on. |

`spectrum(...)` returns an Express `Router`, so an Express mount prefix stacks on
top of `path` — `server.use("/hooks", spectrum({ app, onMessage }))` serves
`POST /hooks/spectrum/webhook`. Prefer setting `path` for a single, explicit
endpoint.

Everything else — signature verification, native-vs-fusor detection,
deserialization, attachment rehydration, status codes, and at-least-once retry
semantics — is exactly [what `app.webhook()` does](./native-webhook.md#what-the-sdk-does-for-you).

## Reference

- Plugin source — `@spectrum-ts/express` (`packages/express/src/index.ts`)
- `app.webhook(request, handler)` — `@spectrum-ts/core` (`packages/core/src/spectrum.ts`)
