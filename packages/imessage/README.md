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

With Spectrum Cloud credentials, inbound received messages arrive through
Fusor's authenticated WebSocket transport. The provider keeps its Advanced
iMessage clients for outbound actions, reactions, polls, and group events, so
cloud apps still maintain supplemental direct gRPC streams; received-message
duplicates on those streams are ignored. Synthetic iMessage envelopes are
stream-only and are never accepted through the public `spectrum.webhook()`
path. Explicit `clients` configurations remain entirely on direct gRPC inbound
transport, so self-hosted endpoints keep their existing behavior.

In auto-discovered dedicated mode, native chats and resources continue to use
their dedicated server directly. Spectrum Cloud also supplies one
project-scoped proxy token, which all of the dedicated lines share for
virtualized `spc-msg-*` and `spc-att-*` resources delivered by Fusor. Replies,
reactions, edits, unsends, message/attachment reads, and mini-app updates are
routed through that proxy only when their resource id is virtual; the proxy
resolves the owning instance and native GUID server-side. A dedicated token
response without `proxyToken` is rejected rather than leaking a virtual GUID
to an instance server. Shared and explicitly configured clients are unchanged.

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
