# Fusor — inbound delivery (streaming & webhooks)

**Fusor** is Photon's inbound pipeline: it receives a webhook from any platform
(Slack, WhatsApp, Discord, a custom provider, …) and delivers it to your
Spectrum app. Spectrum can consume that delivery two ways, and a provider built
on Fusor supports both:

| Transport | You write | Fusor → you over | Connection |
| --- | --- | --- | --- |
| **Streaming** | `for await (… of app.messages)` | a long-lived gRPC stream | Spectrum dials Fusor |
| **Webhook** | `app.webhook(request, handler)` in an HTTP route | an HTTP POST to your endpoint | Fusor calls you |

Both run the **same** per-platform pipeline — verify the platform's signature,
parse the raw request, produce messages, and (optionally) reply. Only the
transport differs. Pick whichever fits your deployment: a long-running worker
(streaming) or a serverless / request-scoped HTTP handler (webhook).

> Only **Fusor-backed providers** (those built with `defineFusorPlatform`, whose
> `createClient` returns a `fusor(...)` client) use this. Providers with their
> own transport — e.g. iMessage via `@photon-ai/advanced-imessage` — do **not**
> go through the Fusor gRPC stream; see [When the gRPC stream
> opens](#when-the-grpc-stream-opens).

---

## The pipeline (shared by both transports)

For every inbound event, Fusor-backed delivery does the same thing:

```
RawInboundEvent
  → route by event.platform
  → parse the original HTTP/1.1 request bytes
  → provider's verify()    (HMAC check — e.g. X-Slack-Signature)
  → provider's messages()  (parse payload → message record(s) + optional reply)
  → deliver message(s)     (to app.messages, or to your webhook handler)
  → reply                  (back to the platform — e.g. Slack url_verification)
```

`verify()` and `messages()` here are **provider-authoring hooks** defined via
`defineFusorPlatform` — the per-platform code that validates the signature and
parses the request. They are *not* something you call:

- **`verify(req)`** turns the raw request into a typed `payload` (and rejects a
  bad signature).
- **`messages({ payload, respond })`** returns the provider message record(s)
  Spectrum delivers, and may call `respond(...)` to set the synchronous reply.
  ⚠️ This provider hook is distinct from **`app.messages`**, the stream *you*
  consume — same word, different thing.

Internally this is `FusorCore.processEvent()`, driven either by the gRPC stream
or by `app.webhook()`. You never call it directly.

---

## Streaming mode — `app.messages`

The default. Spectrum opens one gRPC stream to Fusor and yields each event as a
fully-built `[space, message]`:

```typescript
import { Spectrum } from "spectrum-ts";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [/* a fusor-backed provider */],
});

for await (const [space, message] of app.messages) {
  await space.responding(() => message.reply("hi"));
}
```

Streaming needs `projectId` + `projectSecret` (used to mint the stream's auth
token). Synchronous protocol replies — Slack `url_verification`, WhatsApp
`hub.challenge`, etc. — are produced by the provider automatically and flow back
through the stream; you don't handle them.

---

## Webhook mode — `app.webhook`

Use this when Fusor **POSTs** events to your own HTTPS endpoint (serverless
functions, an existing HTTP server, edge runtimes). `app.webhook()` is
**stateless and request-scoped**: you call it inside your POST handler, it runs
the same pipeline, returns the HTTP response Fusor relays back to the platform
(the platform's `respond()` reply), and dispatches your handler once per resolved
message fire-and-forget — the handler runs after the response and never affects
it.

### Enable it

There's nothing extra to configure — just call `app.webhook()` from your POST
route (see the examples below). No Fusor-specific secret is needed: inbound
authenticity is established by the **platform** signature (Slack/WhatsApp/etc.),
which the pipeline always verifies via the provider's `verify()`. Fusor does not
sign its own outbound POSTs, so Spectrum performs no outer "is this from Fusor?"
check.

### Signatures

```typescript
// Web standard — returns a Response. (Hono, Bun.serve, Next.js, Workers, Deno)
app.webhook(request: Request, handler: WebhookHandler): Promise<Response>;

// Raw — for Express / raw Node. Returns a plain result you write back yourself.
// `headers` are accepted (so passing `req.headers` is fine) but unused.
app.webhook(
  request: { body: Uint8Array | ArrayBuffer; headers?: Record<string, string> },
  handler: WebhookHandler
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

type WebhookHandler = (space: Space, message: Message) => void | Promise<void>;
```

The `handler` receives the same `(space, message)` you'd get from
`app.messages` — `space.send(...)`, `message.reply(...)`, etc. all work. It runs
**fire-and-forget**: the HTTP response (the platform's `respond()` reply) is
computed and returned *first*, then the handler is dispatched without being
awaited — so a slow handler can never delay the response, and a handler error
can't change it (it's caught and logged, like an error in a `for await (… of
app.messages)` loop body). See [Keeping handler work alive](#keeping-handler-work-alive)
for the serverless caveat.

> ⚠️ **Pass the raw body bytes.** The POST body is a protobuf envelope
> (`application/x-protobuf`). Capture it as bytes (`request.arrayBuffer()`,
> `express.raw(...)`) — never `req.json()`/re-encode, or the decode will fail.

### Examples

**Hono** — `c.req.raw` is a Web `Request`:

```typescript
server.post("/webhooks/fusor", (c) =>
  app.webhook(c.req.raw, async (space, message) => {
    await space.send(`echo: ${message.content}`);
  })
);
```

The reply Hono sends is the platform ack, produced by the pipeline — not
whatever your handler does. `space.send(...)` posts a *new* message back to the
platform out-of-band; it is not the HTTP response.

**Bun.serve / Next.js App Router / Cloudflare Workers** — native `Request` →
`Response`:

```typescript
// app/webhooks/fusor/route.ts (Next.js)
export async function POST(req: Request) {
  return app.webhook(req, async (space, message) => {
    await space.send("got it");
  });
}
```

**Express** — use `express.raw` and apply the result:

```typescript
app.post(
  "/webhooks/fusor",
  express.raw({ type: "application/x-protobuf" }), // req.body is a Buffer
  async (req, res) => {
    const result = await app.webhook(
      { headers: req.headers, body: req.body },
      async (space, message) => {
        await space.send("got it");
      }
    );
    res.status(result.status).set(result.headers).send(Buffer.from(result.body));
  }
);
```

### What's automatic vs. your job

- **Automatic:** decode the envelope, route by platform, verify the platform
  signature, parse, build the HTTP response (the platform's `respond()` reply,
  including protocol echoes like Slack `url_verification`), and dispatch your
  handler.
- **Your job:** the `handler` — your application logic for each message. It can't
  affect the HTTP response; it runs after it.

### Status codes & retries

`app.webhook()` returns the status Fusor relays — derived **entirely from the
pipeline**, never from your handler. Fusor delivers **at-least-once** and retries
non-2xx, so the mapping matters:

| Situation | HTTP status | Fusor behavior |
| --- | --- | --- |
| Success (incl. a protocol reply) | reply status, or `200` | done |
| Undecodable body / unknown platform / platform `verify()` failed | `400` (poison) | won't retry |
| Your `handler` threw | `200` (the pipeline ack — the throw is logged, not surfaced) | done, not retried |

Because the handler runs fire-and-forget, **a handler failure does not trigger a
Fusor retry** — if a side effect must survive failure, make it durable yourself
(see below). Delivery is still at-least-once at the Fusor level, so **keep your
handler idempotent** and dedupe on the stable `message.id` for exactly-once
effects.

### Keeping handler work alive

Because the handler runs *after* the response, the runtime must stay alive long
enough for it to finish:

- **Long-running server** (Node `http`, `Bun.serve`, Express, a persistent
  worker) — nothing to do; the event loop keeps the handler running. The examples
  above are all this shape.
- **Serverless / edge** (Vercel, Cloudflare Workers, AWS Lambda) — the function
  can be frozen or torn down the moment you return the response, dropping
  un-awaited handler work. Keeping it alive is **your** responsibility. The
  robust, platform-agnostic pattern is **ack-then-enqueue**: in the handler, push
  the message onto a durable queue (Vercel Queue, Upstash QStash, Inngest, SQS, a
  DB outbox) and do the real work in a separate worker that has its own retries.
  Spectrum intentionally does not manage function lifetime.

### Does not feed `app.messages`

Webhook delivery is request-scoped: messages go to your `handler`, **not** to the
`app.messages` stream. Use one transport or the other per event source; don't
expect a `for await (… of app.messages)` loop to observe webhook traffic.

---

## When the gRPC stream opens

The Fusor gRPC stream is opened **lazily** — only on the first time you consume
`app.messages`:

```typescript
const app = await Spectrum({ providers: [/* fusor provider */], /* … */ });
// No gRPC connection yet.

for await (const [space, message] of app.messages) { /* … */ }
// ↑ first iteration opens the gRPC stream.
```

Consequences:

- **`app.webhook()` never opens the gRPC stream.** A webhook-only deployment
  never connects to Fusor's stream (and doesn't even need `projectId` /
  `projectSecret` for the webhook path — those are only required to mint the
  streaming token).
- **Non-Fusor providers don't use this stream at all.** iMessage, for example,
  is not a Fusor provider; its client comes from `@photon-ai/advanced-imessage`
  and its event subscription opens on first `app.messages` consumption over its
  *own* transport — independent of Fusor.
- If you mix a Fusor provider with a non-Fusor one, the first `app.messages`
  iteration brings up both.

---

## Reference

- `app.webhook(request, handler)` — `src/spectrum.ts`
- Shared pipeline — `FusorCore.processEvent()` in `src/fusor/core.ts`
- Provider authoring — `defineFusorPlatform` / `fusor(platform, verify)` in
  `src/platform/define.ts` and `src/fusor/index.ts`
- Wire envelope — `RawInboundEvent` / `InboundReply` from
  `@photon-ai/proto/photon/fusor/v1/inbound`
- Public types — `WebhookHandler`, `WebhookRawRequest`, `WebhookRawResult`
