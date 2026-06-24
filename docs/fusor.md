# Fusor — inbound delivery (streaming & webhooks)

**Fusor** is Photon's inbound pipeline: it receives a webhook from any platform
(Slack, WhatsApp, Discord, a custom provider, …) and delivers it to your
Spectrum app. Spectrum can consume that delivery two ways, and a provider built
on Fusor supports both:

| Transport | You write | Fusor → you over | Connection |
| --- | --- | --- | --- |
| **Streaming** | `for await (… of app.messages)` | a long-lived WebSocket stream (`fusor.v1.json`) | Spectrum dials Fusor |
| **Webhook** | `app.webhook(request, handler)` in an HTTP route | an HTTP POST to your endpoint | Fusor calls you |

Both run the **same** per-platform pipeline — verify the platform's signature,
parse the raw request, produce messages, and (optionally) reply. Only the
transport differs. Pick whichever fits your deployment: a long-running worker
(streaming) or a serverless / request-scoped HTTP handler (webhook).

> **Streaming transport.** Spectrum dials the Fusor WebSocket plane
> (`fusor.v1.json` protocol) and reconnects with backoff for the life of
> the app. Endpoint: `SPECTRUM_FUSOR_WS_URL` (default
> `wss://fusor-ws.spectrum.photon.codes/v1/subscribe`). The transport
> uses the global `WebSocket` — Bun, Node ≥ 22, browsers, and edge
> workers all qualify; no client library. (A gRPC plane existed during
> the transition and has been retired; cursors and the reply path are
> unchanged.)

<!-- -->

> Only **Fusor-backed providers** use this: a provider is in *fusor mode* when
> its `definePlatform` `lifecycle.createClient` returns a `fusor(...)` client
> (rather than a long-lived SDK client). There is no separate
> `defineFusorPlatform` — it's one overloaded `definePlatform`. Providers with
> their own transport — e.g. iMessage via `@photon-ai/advanced-imessage` — do
> **not** go through the Fusor stream; see [When the stream
> opens](#when-the-stream-opens).

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
`definePlatform` — the per-platform code that validates the signature and
parses the request. They are *not* something you call:

- **`verify(req)`** turns the raw request into a typed `payload` (and rejects a
  bad signature).
- **`messages({ payload, respond, config, store, projectConfig })`** returns the
  provider message record(s) Spectrum delivers, and may call `respond(...)` to
  set the synchronous reply. Besides `payload`/`respond`, the ctx carries the
  same runtime context every other platform hook receives — the parsed `config`
  (typed from your config schema), the per-platform `store`, and the Cloud
  `projectConfig` — so you don't have to smuggle them through the payload. It can
  also return `fusorEvent(channel, data)` to route to a
  [custom event channel](#custom-event-channels-fusorevent) instead of the
  message stream. ⚠️ This provider hook is distinct from **`app.messages`**, the
  stream *you* consume — same word, different thing.

  > Note: in fusor mode the `client` returned by `createClient` is just the
  > `fusor(...)` brand (platform + `verify`), **not** a usable API client, so it
  > is intentionally absent from the ctx. A provider that needs a real API client
  > at message time builds one inline from the ctx `config` (as Telegram does for
  > lazy media downloads — its `createTelegramClient(...)` makes no network call,
  > so there is nothing to cache or thread through the payload).

Internally this is `FusorCore.processEvent()`, driven either by the WebSocket
stream or by `app.webhook()`. You never call it directly.

---

## Streaming mode — `app.messages`

The default. Spectrum opens one WebSocket stream to Fusor and yields each event
as a fully-built `[space, message]`:

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

> ℹ️ **Two webhook formats, one method.** `app.webhook()` also accepts the
> **native Spectrum webhook** — Spectrum Cloud's own HMAC-signed, already-normalized
> JSON deliveries (no raw provider request, no protobuf). It auto-detects the
> format per request by the payload shape — native is JSON, fusor is protobuf
> (both are signed, so the signature header can't discriminate) — and hands your
> handler the same `(space, message)` either way. The native format needs a
> signing secret — see **[Native Spectrum webhooks](./native-webhook.md)**.

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
// `headers` are accepted (passing `req.headers` is fine); they're unused for the
// fusor format but ARE read for native Spectrum webhooks (signature verification).
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

> 🔌 Prefer the first-party **[`@spectrum-ts/hono`](./hono.md)** plugin to mount
> this endpoint in one `app.route(...)`.

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

> 🔌 Prefer the first-party **[`@spectrum-ts/express`](./express.md)** plugin — it
> bundles `express.raw` and the response writing behind one `app.use(...)`.

**ElysiaJS** — use the first-party plugin (it handles the raw-body parsing for
you); see **[ElysiaJS plugin](./elysia.md)**:

```typescript
import { spectrum } from "@spectrum-ts/elysia";

new Elysia().use(
  spectrum({
    app,
    onMessage: async (space, message) => {
      await space.send("got it");
    },
  })
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

## Custom event channels (`fusorEvent`)

Beyond the core message stream, a fusor provider can surface **custom event
channels** — presence, read receipts, typing, reactions, anything that isn't a
message. They appear as flat async-iterable properties on the app
(`app.presence`, `app.readReceipt`, …), unified across every provider that
declares the same channel.

A regular (non-fusor) platform feeds a channel from a long-lived producer. A
fusor platform has no client to stream from, so instead it **declares** each
channel as a Zod schema and **emits** per webhook by returning
`fusorEvent(channel, data)` from `messages`.

### Authoring

```typescript
import { definePlatform, fusor, fusorEvent, type FusorMessages } from "spectrum-ts";
import { z } from "zod";

// 1. Declare each channel under `events` — the KEY is the channel name, the
//    value is a Zod schema describing the payload (and typing `app.<channel>`).
const presenceSchema = z.object({ user: z.string(), online: z.boolean() });

// 2. `messages` MUST be a typed `FusorMessages<…>` reference (not an inline
//    arrow) so overload resolution selects fusor mode — see the note below.
const messages: FusorMessages<MyPayload> = ({ payload }) => {
  if (payload.kind === "presence") {
    return fusorEvent("presence", { user: payload.user, online: true });
  }
  // A bare record (or `fusorEvent("messages", record)`) goes to app.messages.
  return { id: payload.id, content: payload.content, sender, space };
};

export const myProvider = definePlatform("myplatform", {
  config: z.object({ /* … */ }),
  lifecycle: { createClient: ({ config }) => Promise.resolve(fusor("myplatform", makeVerify(config))) },
  user: { /* … */ },
  space: { /* … */ },
  events: { presence: presenceSchema }, // ← channel declaration
  messages,
  send,
});
```

Three ways a `messages` handler can route its return value:

| Return | Goes to |
| --- | --- |
| a bare `ProviderMessageRecord` (or array) | `app.messages` / the webhook handler |
| `fusorEvent("messages", record)` | identical to the bare record above |
| `fusorEvent("presence", data)` | the `presence` channel (`app.presence`) |

The channel name in `fusorEvent(name, …)` is **not** type-checked against your
declared `events` — a name that isn't a declared channel is logged with a
warning and dropped (not silently lost). Keep it in sync with the `events` keys.

### Consuming

```typescript
for await (const presence of app.presence) {
  // presence: { user: string; online: boolean; platform: "myplatform" }
}
```

Each event is the channel payload plus a `platform` tag identifying which
provider emitted it. Custom events flow on **both** transports, but they go to
the channel stream — **never** to the `app.webhook()` handler, which is
messages-only.

> **Authoring note — fusor mode selection.** `definePlatform` is overloaded; the
> regular overload is tried first. A fusor provider is only matched when its
> `messages` is a **typed `FusorMessages<…>` reference** (like the example
> above) — an inline `messages: ({ payload }) => …` arrow is deferred during
> overload resolution and mis-commits to the regular overload. Annotating
> `createClient`'s return as `Promise<FusorClient<…>>` is also good practice.

---

## When the stream opens

The Fusor stream is opened **lazily** — only on the first time you consume
`app.messages`:

```typescript
const app = await Spectrum({ providers: [/* fusor provider */], /* … */ });
// No Fusor connection yet.

for await (const [space, message] of app.messages) { /* … */ }
// ↑ first iteration opens the stream.
```

Consequences:

- **`app.webhook()` never opens the stream.** A webhook-only deployment
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

## The WebSocket transport

The streaming transport speaks **`fusor.v1.json`** — Fusor's public
WebSocket protocol. This section documents what's on the wire, why it's
shaped that way, and the liveness machinery around it. You don't need
any of it to *use* the SDK — `app.messages` hides the transport — but
it's the contract to implement if you're building a non-TypeScript
client.

### Why raw WebSocket (and not Socket.IO)

`fusor.v1.json` is plain RFC 6455 WebSocket plus JSON text frames —
deliberately **not** Socket.IO or any framework protocol:

- **Reach is the whole point.** The retired gRPC plane needed a private
  proto package and gRPC tooling; the WebSocket plane exists so browsers,
  edge workers, and any language's stdlib can consume events. Socket.IO would
  recreate the same lock-in one layer down: every consumer must embed a
  Socket.IO client of a compatible major version (the v2/v3/v4 protocol
  breaks are notorious), and those clients are weak outside JavaScript
  and painful in edge runtimes. A raw socket works with the bare
  `WebSocket` global and is debuggable with `wscat`.
- **It's the industry pattern for platform realtime APIs.** Discord's
  gateway, Slack's Socket Mode, OpenAI's Realtime API, and GraphQL's
  `graphql-transport-ws` are all raw WebSocket + a documented JSON
  protocol negotiated per connection. Socket.IO is popular for
  app-internal realtime where one team owns both ends — not as a public
  contract.
- **What Socket.IO would add, the protocol already covers** with
  Fusor-specific semantics a generic library can't provide: versioning
  via subprotocol negotiation, app-level heartbeats, resume via the
  JetStream cursor (not session replay), and typed errors with a
  gRPC-style status vocabulary. Its one unique feature — HTTP
  long-polling fallback — would break streaming semantics for a network
  condition that's effectively extinct.

### The protocol

**Handshake.** `GET wss://…/v1/subscribe` offering the subprotocol
`fusor.v1.json` (`Sec-WebSocket-Protocol`); the server echoes it on the
`101`. `fusor.v1.proto` is reserved for a future binary variant. All
frames are JSON text; binary frames are a protocol violation. Receivers
ignore unknown *fields*, and clients must ignore unknown *server frame
types* (v1 can grow).

**Field naming is the protobuf JSON mapping** of the public messages
(`RawInboundEvent` / `InboundReply` from `@photon-ai/proto`): `eventId`,
`startSeq`, base64 for `bytes`, RFC3339 for timestamps. A future binary
subprotocol is lossless by construction.

| Direction | Frame | Purpose |
| --- | --- | --- |
| → server | `init` | First frame, required: `{ "type":"init", "startSeq":0, "token":"<jwt>" }`. `startSeq` is the JetStream cursor — `0` = live tail, `>0` = replay after that sequence. |
| → server | `reply` | Synchronous reply for an event that carried `replyExpected: true`: `{ "type":"reply", "eventId", "status", "headers", "body":"<base64>", "errorReason" }`. |
| → server | `ping` | Optional liveness escape hatch; echoed as `pong`. |
| ← client | `ready` | Auth + subscription live. Carries `projectId`, the `startSeq` echo, `heartbeatIntervalMs`, and server limits. |
| ← client | `event` | `{ "type":"event", "seq", "replyExpected"?, "event": { "eventId", "projectId", "platform", "receivedAt", "prevSubjectSeq", "rawRequest":"<base64>" } }` — `rawRequest` is the original HTTP/1.1 wire bytes; the SDK pipeline is shared with the webhook transport. |
| ← client | `heartbeat` | App-level keepalive (see below). |
| ← client | `error` | Typed notice. `fatal: true` is always followed by a close with a mapped code; `fatal: false` means the stream keeps running (e.g. `reply_unknown_event`). |

**Replies.** `replyExpected` is a boolean — reply only when it's `true`.
(The server answers blind replies with a non-fatal `reply_unknown_event`
notice.) The SDK handles this for you.

**Close codes.** Every server-initiated close is preceded by a fatal
`error` frame: `4401` unauthenticated (re-mint the token — the SDK
invalidates its cached JWT automatically), `4400` protocol violation and
`4413` frame too large (fix the client; don't hot-loop), `4408` init
timeout, `4429` slow consumer (the server closes rather than buffer
unboundedly), `1001` server draining, `1013` upstream unavailable —
the last three plus `1011` are plain reconnect-with-backoff cases.

### Auth

A LightAuth JWT (`aud: codes.photon.spectrum.fusor`), minted by
spectrum-cloud from your project credentials. The SDK sends it inside
the `init` frame rather than an `Authorization` header so the transport
works in runtimes that can't set upgrade headers (browsers, some
workers); the server also accepts `Authorization: Bearer` at upgrade for
clients that can.

### Keepalive & liveness

Three layers, each with a distinct job:

- **Server → client heartbeats.** The server sends
  `{ "type":"heartbeat" }` frames on the cadence advertised in `ready`
  (`heartbeatIntervalMs`, 30s today). They're app-level *data* frames —
  browsers can't observe protocol-level pings — and they double as
  traffic that keeps the connection far inside the edge load balancer's
  idle timeout.
- **Client staleness watchdog.** The SDK treats *no frame of any kind*
  for `2 × heartbeatIntervalMs + 5s` as a dead intermediary, fails the
  session, and lets the reconnect loop take over. Implement the same rule
  in a custom client.
- **Client → server `ping`.** Optional; for runtimes whose protocol-ping
  handling is broken. Any received frame counts as liveness on the server
  side too.

There is no Socket.IO-style per-message ack machinery: delivery
guarantees come from the broker (the server acks its stream only once a
frame is accepted into the transport buffer) plus the `seq` cursor and
`eventId` dedup on reconnect.

### Reconnect

The SDK reconnects with exponential backoff (1s → 30s). On `4401` it
re-mints the token before retrying. Today reconnects resume as a live
tail (`startSeq: 0`); cursor persistence — resuming from the last seen
`seq` across restarts — is tracked in
[photon-hq/fusor#9](https://github.com/photon-hq/fusor/issues/9)
and will slot into the same `init` field.

**Runtime requirements:** the global `WebSocket` constructor — Bun,
Node ≥ 22, browsers, and edge workers qualify; no client library is
involved.

---

## Reference

- `app.webhook(request, handler)` — `src/spectrum.ts`
- Shared pipeline — `FusorCore.processEvent()` in `src/fusor/core.ts`
- Provider authoring — `definePlatform` (fusor overload) / `fusor(platform, verify)`
  in `src/platform/define.ts` and `src/fusor/index.ts`
- Custom events — `fusorEvent(channel, data)` in `src/fusor/event.ts`
- Wire envelope — `RawInboundEvent` / `InboundReply` from
  `@photon-ai/proto/photon/fusor/v1/inbound`
- WebSocket transport client — `runFusorWsSession` in
  `src/fusor/websocket.ts`; reconnect loop in `FusorCore` (`src/fusor/core.ts`)
- Server-side `fusor.v1.json` spec — `apps/fanout-websocket/BEHAVIOR.md`
  in the fusor repo (frame schemas, close-code matrix, e2e recipes)
- Public types — `WebhookHandler`, `WebhookRawRequest`, `WebhookRawResult`,
  `FusorEvent`
