# @spectrum-ts/imessage

iMessage provider for [spectrum-ts](https://github.com/photon-hq/spectrum-ts), including tapbacks, special effects, polls, and iMessage Apps.

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

This package also exports the iMessage-specific content helpers `effect`, `read`, `background`, `customizedMiniApp`, and `nativeContactCard`.

`nativeContactCard()` shares the bot account's own contact card (Apple's "Share Name and Photo") with a chat — remote mode only:

```ts
import { nativeContactCard } from "@spectrum-ts/imessage";

await space.send(nativeContactCard());
// or the sugar form, typed on the iMessage space:
await space.shareContactCard();
```

## Incoming polls

Native iMessage polls can have an empty title. Match a poll with
`content.pollMessageGuid`, not its title. Match a selected option with
`content.option.optionIdentifier`, not its label. Different options can have
identical labels.

Poll creation and option additions arrive as `content.type === "poll"`, with
`content.change` set to `"created"` or `"optionAdded"`. Both contain the full
current option set. An option addition does not represent a vote.

Votes and removed votes arrive as `content.type === "poll_option"`, with
`selected` set to `true` or `false`. The nested `content.poll` retains the poll
GUID and option identifiers. Use the vote/update message ID for duplicate
detection and the poll GUID for correlation. A created poll uses its root GUID
as its message ID.

```ts
if (message.content.type === "poll_option") {
  const { pollMessageGuid, option, selected } = message.content;
  // Correlate by pollMessageGuid and option.optionIdentifier.
}
```

These fields are optional on shared Spectrum content because other providers
can still supply polls without native identifiers. The `poll(title, ...)`
builder still requires a nonempty title. Native snapshots with a poll GUID
require distinct option identifiers, even when their labels are equal.

The native `app.webhook()` handler preserves the same poll content types and
identifiers. Hosted delivery also requires the corresponding webhook-worker
update and SDK rollout; updating only the receiving application is not enough.
Previously skipped events are not automatically replayed.

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.

For direct access to the local macOS Messages database, install and import
`@spectrum-ts/imessage-local` separately. The local provider is intentionally
not included in the batteries-included `spectrum-ts` package.

```sh
bun add @spectrum-ts/imessage-local
```
