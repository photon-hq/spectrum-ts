# `Spectrum.stopOnce` teardown — deferred structural fix

## Summary

In production, `Spectrum.stopOnce()` consistently exceeds downstream
consumers' shutdown budgets (e.g. `spectrum-webhook`'s 1500ms
`POOL_STOP_TIMEOUT_MS`) for the iMessage provider. The 100% timeout
rate leaves an orphan SDK instance running in a background closure
until its teardown eventually completes.

The straightforward structural fix — reorder `stopOnce` to close the
provider client (TCP-RST the upstream gRPC channel) before draining
the in-process stream cascade — was attempted in
[#84](https://github.com/photon-hq/spectrum-ts/pull/84) and
deferred. This doc captures why, so the next engineer who looks at
the timeout doesn't re-litigate the same conclusion.

## What's actually happening

`stopOnce` runs two sequential phases:

1. **Phase 1 — drain in-process streams** (`messagesStream`, custom
   event streams, message broadcasters).
2. **Phase 2 — destroy provider clients** (`destroyClient` lifecycle
   hook; for iMessage this is where the gRPC channel close runs).

The iMessage provider's `messages` async iterator does not honor
`return()` cooperatively. The flow:

- Phase 1 calls `.return()` on the merged iterator stack.
- Inner Repeater layers honor return; the outermost
  `client.messages.subscribeEvents()` gRPC call does not — it sits
  awaiting the next frame from the upstream stream.
- Phase 1 hangs.
- The downstream consumer's outer timeout fires (1500ms for
  `spectrum-webhook`); the consumer abandons the promise.
- Phase 2 never runs in the consumer's wait window.
- Eventually (seconds to minutes later), the upstream gRPC stream
  errors out for other reasons (heartbeat, server-side close,
  connection refresh) and the iterator finally returns. Phase 2
  runs, the channel closes, the SDK is gone.

That eventual completion is visible in production logs as the
bare `[spectrum.lifecycle] Spectrum stopped` lines that appear
seconds after the *next* instance has already started — the dying
orphan finally finished.

## Why the reorder fix was deferred

PR [#84](https://github.com/photon-hq/spectrum-ts/pull/84) proposed
running Phase 2 first (close channels, then drain streams). The
hypothesis was: with the gRPC channel closed up front, the upstream
relay would observe disconnect within milliseconds and reroute
subsequent events to the newly-started SDK instance for the same
project.

That hypothesis turned out to be **incomplete**.

### The relay broadcasts; orphans don't starve

`spectrum-imessage` (the proxy in front of the Mac fleet) is a
fan-out broadcaster, not a single-subscriber router. When N
downstream subscribers register for the same project's events, the
proxy delivers each upstream event to all N via independent
filtered streams (see `connection-registry.ts:activeEventSubscriptions`
— a `Set`, not a slot).

Consequence: an orphan SDK and a freshly-started SDK both receive
every event for their shared project. Neither one starves the
other. Both call their respective `onMessage` callbacks. The
downstream consumer's store is keyed by project, so both dispatch
paths end up posting to the same customer webhook URL.

The webhook protocol is at-least-once. The orphan never causes
message loss — only (rare, bounded) double-delivery during the
overlap window before the orphan dies.

### What an orphan *does* cost

- A few seconds to a few minutes of held-open gRPC stream + iterator
  state in the SDK process memory, until the underlying stream errors
  out and Phase 2 runs.
- Log noise: every `pool.stop` for an iMessage project logs as
  `timedOut=true`.
- Theoretical double-delivery during the overlap window
  (mostly invisible in production logs; the orphan's stream
  appears to lose events to other concurrent SDK behaviors before
  it would deliver them).

None of these are customer-facing. The original josh-incident
diagnosis that pinned 23 hours of webhook silence on this orphan
was traced to a different root cause (`spectrum-imessage`'s
[`resilientStream`](https://github.com/photon-hq/spectrum-imessage/pull/26)
retry policy giving up on non-whitelisted gRPC errors).

### Why "tolerable" doesn't mean "fine forever"

There are scenarios where the orphan window matters:

- **Memory pressure under high churn** — if a worker has many
  rapid stop/start cycles (e.g. a customer iterating on their
  ngrok tunnel URL with DELETE/INSERT bursts), orphans accumulate
  faster than they die. Production is nowhere near that bound
  today, but it's worth measuring.
- **Token rotation across orphan boundary** — the orphan's gRPC
  stream holds an auth token issued at start time. If a project
  secret rotation happens during the orphan's lifetime, the
  orphan still consumes events under the old auth. Currently
  benign because the proxy doesn't re-validate per event, but a
  future security feature that did would observe odd behavior.
- **Double-delivery to non-idempotent customer endpoints** —
  customers should be coded for at-least-once, but not all are.

The current decision: ship instrumentation
([#85](https://github.com/photon-hq/spectrum-ts/pull/85)), gather a
few weeks of production timing data on `clientCloseMs` /
`streamCloseMs`, then decide whether the structural cost is real
enough to warrant the reorder.

## Criteria for revisiting the structural fix

Reopen the reorder discussion when **any** of these hold:

1. **`clientCloseMs` p99 is consistently > 100ms**. If the channel
   close itself is slow (not the stream drain), the reorder solves
   nothing — fix that first.
2. **Production memory growth correlates with stop frequency**.
   Indicates orphans accumulate faster than they die.
3. **A customer-reported double-delivery incident** is traced to
   the overlap window (would require correlated log timestamps from
   webhook + proxy + customer endpoint).
4. **The `messages` iterator becomes return()-honoring upstream**
   in `@photon-ai/advanced-imessage`. At that point the entire
   teardown completes cleanly within the existing budget and the
   reorder discussion becomes moot.

## Reference: the code

- `packages/spectrum-ts/src/spectrum.ts` — `stopOnce` definition;
  current order is stream-drain → client-destroy, instrumented
  with `streamCloseMs` / `clientCloseMs` timings.
- `packages/spectrum-ts/src/providers/imessage/remote/stream.ts`
  — the `withClose` wrapper; uses optional chaining
  (`source.close?.()`), which silently no-ops when the upstream
  gRPC call lacks a callable `close()`. This is the layer where
  a future iterator-return fix would land.
