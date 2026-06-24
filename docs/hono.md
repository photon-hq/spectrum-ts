# Hono plugin

`@spectrum-ts/hono` is a first-party [Hono](https://hono.dev) plugin that mounts a
Spectrum webhook endpoint in a single `.route()`. It wraps
[`app.webhook()`](./fusor.md#webhook-mode--appwebhook), so it handles **both**
webhook formats — the [native Spectrum webhook](./native-webhook.md) (HMAC-signed
JSON) and the [Fusor webhook](./fusor.md) (protobuf) — and hands your `onMessage`
the same `(space, message)` either way.

## Why a plugin (and not just a route)

Unlike Elysia, Hono needs **no** body-parsing workaround: it never auto-parses a
request body, so `c.req.raw` is the exact, untouched Web `Request` (the body is
only consumed if you call `c.req.json()` / `c.req.parseBody()`). That matters
because Spectrum verifies the native webhook's HMAC over the **exact wire bytes** —
re-encoding the body would break it.

So the raw route is already a clean one-liner:

```ts
server.post("/spectrum/webhook", (c) => app.webhook(c.req.raw, onMessage)); // ✓
```

The plugin is the same thing with the ergonomics matched to Elysia and Express: a
single import, the route + default path owned for you, and a typed `onMessage`. It
returns a mountable Hono sub-app, so you compose it with `app.route(...)`.

> ⚠️ The one rule, plugin or not: pass `c.req.raw` — never `c.req.json()` or
> `c.req.parseBody()`. Reading the body re-encodes it and breaks signature
> verification.

## Install

```bash
bun add spectrum-ts @spectrum-ts/hono hono
```

`spectrum-ts` provides `Spectrum` (and your providers); `@spectrum-ts/hono` is the
plugin; `hono` is its required peer dependency. (Using `@spectrum-ts/core` directly
instead of the metapackage? Swap it in for `spectrum-ts`.)

## Usage

```ts
import { Hono } from "hono";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spectrum } from "@spectrum-ts/hono";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config()],
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET, // for native webhooks
});

const server = new Hono().route(
  "/",
  spectrum({
    app,
    onMessage: async (space, message) => {
      if (message.content.type === "text") {
        await space.send(`echo: ${message.content.text}`);
      }
    },
  })
);

export default server; // Bun.serve, Cloudflare Workers, Deno, Node adapter, …
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

- Plugin source — `@spectrum-ts/hono` (`packages/hono/src/index.ts`)
- `app.webhook(request, handler)` — `@spectrum-ts/core` (`packages/core/src/spectrum.ts`)
