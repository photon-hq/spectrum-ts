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

See the [spectrum-ts documentation](https://photon.codes/spectrum) for the full guide.

For direct access to the local macOS Messages database, install and import
`@spectrum-ts/imessage-local` separately. The local provider is intentionally
not included in the batteries-included `spectrum-ts` package.

```sh
bun add @spectrum-ts/imessage-local
```

### Conversation updates

Content-less native `chatAction`, `groupNameChange`, and `participantChange`
records arrive as `custom` content with
`raw: { imessage_type: "conversation-event", itemType }`. They retain message
metadata and remain available to consumers. Records with supported content
(text, attachments, or app cards) keep their existing content mapping; other
unsupported messages still use `unsupported-message`.

Agent consumers can filter these updates with the exported helper:

```ts
import { isIMessageConversationEvent } from "@spectrum-ts/imessage";

if (isIMessageConversationEvent(message)) {
  return;
}
```

The helper checks reply-wrapped content, not reply targets. Structured group
updates such as `rename` and `addMember` retain their existing content types
and can be handled separately by the consumer.
