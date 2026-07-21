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

### Inbound stream buffering

Set `bufferLimit` to a positive integer to change how many live inbound events
can wait while a disconnected stream catches up:

```ts
imessage.config({ bufferLimit: 2_000 });
```

The limit applies separately to each message, poll, and dedicated-line group
stream for every configured line. Omit it to use Spectrum core's default of
`1_000` events per stream.

The cloud provider's gRPC catch-up API is a finite replay stream and does not
support page sizing. `catchUpPageSize` is therefore not an iMessage config
option; passing it is rejected instead of silently doing nothing.

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
