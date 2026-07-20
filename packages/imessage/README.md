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
Fusor's authenticated WebSocket transport. The existing `spectrum-webhook`
service can continue delivering customer webhooks by consuming that stream;
raw Fusor envelopes are not accepted through the public `spectrum.webhook()`
handler. The SDK no longer opens direct gRPC inbound streams.

All outbound sends and unary, attachment, and file operations use Advanced
iMessage HTTP clients. Spectrum Cloud returns each dedicated instance's token
and assigned E.164 phone; the SDK sends the instance id to the existing HTTP
adapter as routing metadata and selects the client by phone. Dedicated chat,
message, and attachment GUIDs remain native and unchanged, including resources
created before migration. The Fusor line id is verified as inbound transport
provenance but is not exposed on SDK spaces. Shared projects retain their
existing `spc-*` behavior. Explicit `clients` configurations also describe
Advanced iMessage HTTP endpoints, but are outbound-only: inbound delivery
requires Spectrum Cloud credentials so the SDK can authenticate to Fusor
WebSocket.

The HTTP middleware can be overridden with
`SPECTRUM_IMESSAGE_HTTP_ADDRESS`; this is intentionally separate from the
legacy gRPC-only `SPECTRUM_IMESSAGE_ADDRESS`.

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
