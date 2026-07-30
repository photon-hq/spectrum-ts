# @spectrum-ts/imessage

iMessage provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts), including tapbacks, special effects, polls, and mini-apps.

## Install

```sh
bun add spectrum-ts @spectrum-ts/imessage
```

## Use

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

const spectrum = Spectrum({
  providers: [imessage.config()],
});
```

With Spectrum Cloud credentials, the provider discovers whether the project
uses shared or dedicated iMessage lines. Inbound messages arrive through
Fusor's authenticated WebSocket transport. The existing
`spectrum-webhook` service remains the separate, legacy webhook transport;
raw Fusor envelopes are not accepted through the public `app.webhook()`
handler. Applications should choose WebSocket or webhook delivery (or dedupe
across both intentionally). The SDK no longer opens direct gRPC streams.

Dedicated Fusor delivery includes received messages, added reactions, read
receipts, poll changes, and group changes. Shared feed v2 includes received
messages, added reactions, read receipts, and poll changes while retaining the
existing `spc-*` virtual IDs. Unsupported message changes remain deliberate
no-ops because they do not map to a public Spectrum message. Supplemental
events keep the same public IDs as the former direct stream and carry the
stable line phone on their spaces.

All outbound sends and unary, attachment, and file operations use Advanced
iMessage HTTP clients. Spectrum Cloud returns each dedicated instance's token
and assigned E.164 phone; the SDK sends the instance id to the existing HTTP
adapter as routing metadata and selects the client by phone. Dedicated chat,
message, and attachment GUIDs remain native and unchanged, including resources
created before migration. The Fusor line id is verified as inbound transport
provenance but is not exposed on SDK spaces. Shared projects retain their
existing `spc-*` behavior. Explicit `clients` configurations describe Advanced
iMessage HTTP endpoints. When Spectrum project credentials are also supplied,
Fusor WebSocket remains enabled and routes inbound events to the configured
phones; without project credentials, explicit clients are outbound/webhook-only.
A client may set `server` to send the dedicated instance id as HTTP routing
metadata when its `address` is a shared HTTP gateway. Direct per-instance HTTP
endpoints can omit it.

The HTTP middleware can be overridden with
`SPECTRUM_IMESSAGE_HTTP_ADDRESS`; this is intentionally separate from the
legacy gRPC-only `SPECTRUM_IMESSAGE_ADDRESS`.

Iterating `spectrum.messages` in cloud mode opens a WebSocket connection. The
runtime must provide a global `WebSocket` implementation; use Bun or Node.js
22 or newer. Webhook-only applications do not open this connection.
`SPECTRUM_FUSOR_WS_URL` can override the production
`wss://.../v1/subscribe` endpoint for a staging or private Fusor deployment.

By default, a fresh process subscribes at Fusor's live tail. To resume across
process restarts, provide a durable cursor store through
`Spectrum({ options: { fusorCursorStore } })`. Every `save` must atomically keep
the maximum sequence: even one process can retry while a timed-out write
finishes late. Cursor operations are capped at five seconds by default; set
`options.fusorCursorStoreTimeoutMs` when the store needs a different bounded
deadline (1–300,000 milliseconds). The cursor confirms that an event was
verified, normalized, and synchronously enqueued inside the SDK; it does not
confirm that application code consumed the in-memory message. Use a durable
application queue or database when end-to-end processing guarantees are
required.

This package also exports the iMessage-specific content helpers `effect`, `read`, `background`, `customizedMiniApp`, and `nativeContactCard`.

`nativeContactCard()` shares the bot account's own contact card (Apple's "Share Name and Photo") with a chat — remote mode only:

```ts
import { nativeContactCard } from "@spectrum-ts/imessage";

await space.send(nativeContactCard());
// or the sugar form, typed on the iMessage space:
await space.shareContactCard();
```

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.

For direct access to the local macOS Messages database, install and import
`@spectrum-ts/imessage-local` separately. The local provider is intentionally
not included in the batteries-included `spectrum-ts` package.

```sh
bun add @spectrum-ts/imessage-local
```
