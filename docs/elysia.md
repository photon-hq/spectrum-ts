# ElysiaJS plugin

`@spectrum-ts/elysia` is a first-party [ElysiaJS](https://elysiajs.com) plugin that
mounts a Spectrum webhook endpoint in a single `.use()`. It wraps
[`app.webhook()`](./fusor.md#webhook-mode--appwebhook), so it handles **both**
webhook formats — the [native Spectrum webhook](./native-webhook.md) (HMAC-signed
JSON) and the [Fusor webhook](./fusor.md) (protobuf) — and hands your `onMessage`
the same `(space, message)` either way.

## Why a plugin (and not just a route)

Elysia's `parse` lifecycle auto-parses `application/json` request bodies **before**
your handler runs, which consumes the `Request` body stream. So the naive

```ts
new Elysia().post("/webhook", ({ request }) => app.webhook(request, handler)); // ✗
```

throws `body already used`, and — because Spectrum verifies the HMAC over the
**exact wire bytes** — any framework that re-encodes the JSON would also break
signature verification. The plugin sets `parse: "none"` on its route so Elysia
leaves the body untouched, then forwards the raw `Request` straight to
`app.webhook()`.

## Install

```bash
bun add spectrum-ts @spectrum-ts/elysia elysia
```

`spectrum-ts` provides `Spectrum` (and your providers); `@spectrum-ts/elysia` is the
plugin; `elysia` is its required peer dependency. (Using `@spectrum-ts/core`
directly instead of the metapackage? Swap it in for `spectrum-ts`.)

## Usage

```ts
import { Elysia } from "elysia";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spectrum } from "@spectrum-ts/elysia";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config()],
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET, // for native webhooks
});

new Elysia()
  .use(
    spectrum({
      app,
      onMessage: async (space, message) => {
        if (message.content.type === "text") {
          await space.send(`echo: ${message.content.text}`);
        }
      },
    })
  )
  .listen(3000);
```

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `app` | `Spectrum` instance | — | The instance returned by `await Spectrum({...})`. |
| `onMessage` | `(space, message) => void \| Promise<void>` | — | Invoked once per inbound message, **fire-and-forget** after the response (a throw is logged, never surfaced). Dedupe on `message.id` for exactly-once side effects. |
| `path` | `string` | `"/spectrum/webhook"` | Route the endpoint is mounted on. |

Everything else — signature verification, native-vs-fusor detection,
deserialization, attachment rehydration, status codes, and at-least-once retry
semantics — is exactly [what `app.webhook()` does](./native-webhook.md#what-the-sdk-does-for-you).

## Reference

- Plugin source — `@spectrum-ts/elysia` (`packages/elysia/src/index.ts`)
- `app.webhook(request, handler)` — `@spectrum-ts/core` (`packages/core/src/spectrum.ts`)
