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

## Observing live heartbeats

Set the optional `onHeartbeat` observer on the remote iMessage provider:

```ts
imessage.config({
  onHeartbeat(heartbeat) {
    console.debug("iMessage heartbeat", heartbeat);
  },
});
```

The observer uses the existing subscriptions started by consuming
`spectrum.messages`. Configuring it alone does not start subscriptions.

The exported `IMessageHeartbeat` payload contains `provider` (`"imessage"`),
`projectId`, `lineId`, `phone`, `stream`, `subscriptionId`, and `receivedAt`.
`projectId` is undefined without a Cloud project. `lineId` is the Cloud instance
ID or a process-local key for an explicit client; phone numbers alone are not
unique. `stream` is `"messages"`, `"polls"`, or `"groups"`. Shared-token mode
keeps its existing messages/polls subscriptions and does not subscribe to groups.
This observer does not create chat or location subscriptions.

`subscriptionId` is an opaque ID for one live subscription. Reconnects get a new
ID, even for the same line and stream. `receivedAt` is local Unix time in
milliseconds when the SDK consumes the heartbeat, not the server's send time.
Keep observations separate by project, line, stream, and subscription: a healthy
poll stream does not prove the message stream is progressing. Closing or removing
a subscription retires its observer; `spectrum.stop()` prevents new callbacks.

**These are pull-driven observations, not independent transport monitoring.**
Mapping work and application backpressure can pause a stream's reads, including
its heartbeats, while a sibling continues. A callback is not a domain message,
a processing-completion signal, or a durable delivery acknowledgement. Neither
ordinary message silence nor missing callbacks alone proves a dead connection.
Use this signal with lifecycle and processing diagnostics before deciding how to
recover. No watchdog, heartbeat timeout, reconnect policy, or replay is added.

Keep the observer quick. The exported `IMessageHeartbeatHandler` accepts a
synchronous callback or a promise; promises are not awaited and may finish out of
order. Throws and rejections are logged without interrupting the stream. Stopping
does not cancel or wait for asynchronous work an observer has already started.
The option is off by default; existing configurations and message payloads are
unchanged. This provider requires `@photon-ai/advanced-imessage` 2.4.0 or newer.

## Pending processing diagnostics

Remote iMessage streams log `stream operation still pending` once when a mapping
or emission call remains pending for 30 seconds. These warnings use existing SDK
telemetry and do not require `onHeartbeat` or another application option. A quiet
subscription waiting for its next raw event has no diagnostic timer.

`mapping` means the SDK is awaiting conversion of a raw event, including any
lookups that conversion needs. `emit` means it is awaiting the next downstream
consumer pull. Downstream consumers include SDK merge streams and the application.
Neither state proves a broken connection. Each warning proves that the SDK
already pulled that raw event. Normal receipt and short operations produce no
new diagnostic records.

| Field | Meaning |
| --- | --- |
| `provider`, `projectId`, `lineId`, `stream`, `subscriptionId` | The same identities as heartbeat observations, without the phone number. IDs exist even when the heartbeat observer is off. |
| `spectrum.stream.id` | One core stream lifetime, including its reconnects. This differs from a live subscription ID. |
| `spectrum.stream.operation` | `mapping` or `emit`. |
| `spectrum.stream.origin` | `live`, `catch-up`, or `buffered-live`. Buffered events remain distinct until the catch-up buffer drains. |
| `spectrum.stream.subscription_role` | `source` for live events. For catch-up, `concurrent-live` identifies the parallel live subscription, not the historical event's source subscription. |
| `spectrum.stream.event_cursor`, `spectrum.stream.event_cursor_kind`, `spectrum.stream.event_type` | The raw event sequence and type. A catch-up completion marker uses its head sequence with kind `catch-up-head`. |
| `spectrum.stream.cursor` | The stream's resume cursor when this event started mapping. This is not a durable application acknowledgement. |
| `spectrum.stream.pending_ms` | Elapsed time for this pending call, measured with a monotonic clock. |

If a warned call settles while the stream remains active, the SDK logs
`previously pending stream operation settled`. Its `spectrum.stream.outcome` is
`completed` or `failed`. Completion means only that the awaited SDK call returned.
It does not prove that a domain message was emitted, forwarded, or acknowledged.

Closing or removing a line stops its diagnostics before awaiting remaining
cleanup. A missing settlement record after close does not prove that work still
runs. Warnings do not cancel work, release ownership, advance cursors, retry,
restart, or replay. The 30-second threshold is an observation threshold, not a
production-calibrated health limit. Timers do not keep Node running.

The new records contain no message content, phone numbers, callback URLs,
credentials, or signing secrets. Existing logs and the public heartbeat payload
keep their existing fields. No per-message success log, background watchdog,
subscription registry, or metric label is added. Other providers remain unchanged
unless their authoring code supplies `CloseableAsyncIterable.diagnosticAttrs`.
Provider authors can add raw event metadata with `eventDiagnosticAttrs` on
`resumableOrderedStream`. Both metadata sources must exclude private data.

These records cannot identify a stall before raw receipt, during synchronous
JavaScript that blocks timers, or inside the transport. Use proxy diagnostics and
worker receipt records to examine those remaining boundaries. Server subscription,
SDK subscription, and worker-instance IDs still represent separate lifetimes.

## Incoming polls

Native iMessage polls have no title. Their snapshots and nested vote context
omit the `title` field; option labels still use `title`. Match a poll with
`content.pollMessageGuid`. Match a selected option with
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
