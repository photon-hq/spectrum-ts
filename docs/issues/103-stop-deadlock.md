# Issue #103 — `Spectrum.stop()` shutdown deadlock

> Status: **fixed** · Affected: `spectrum-ts` ≤ 1.18.0 · Component: `SpectrumInstance.stop()` lifecycle
>
> [github.com/photon-hq/spectrum-ts/issues/103](https://github.com/photon-hq/spectrum-ts/issues/103)

## Summary

`Spectrum.stop()` could hang forever when an app had an active `spectrum.messages`
(or custom-event) subscription. After consuming inbound events and calling
`stop()`, the call never resolved — leaving dangling subprocesses (terminal),
open connections, and signal-based shutdown (SIGINT/SIGTERM) unable to exit.

The bug was **not** terminal-specific. It lived in the core stream-consumption
and shutdown-ordering logic and reproduced with plain custom providers — both the
native-`async *` shape (terminal) and the `ManagedStream` shape (iMessage, Slack,
WhatsApp).

## Reproduction (pre-fix)

Subscribe, consume one message, then stop:

```ts
const app = await Spectrum({ providers: [terminal.config()] });
const it = app.messages[Symbol.asyncIterator]();
await it.next();          // consume one inbound message
await app.stop();         // ← never resolves
```

Verified independently of terminal with a minimal custom provider whose message
source only closes during `destroyClient`, and with an iMessage-shaped provider
that returns a `ManagedStream`. Both deadlocked on `main`.

## Root cause

### 1. Shutdown ordering: streams closed *before* clients destroyed

`stopOnce()` ran in phases: **(1)** `await` every stream `close()`, **(2)** fusor
core close, **(3)** provider `destroyClient()`. Phase 1 blocked on Phase 3.

### 2. The core wrapped every provider source in a native async generator

`createProviderMessagesStream` / `createCustomEventStream` consumed the provider's
raw source through an intermediate **native async generator** (`bindSend` /
`annotatePlatform`) and then `adaptIterable`. On close, `adaptIterable` called
`iterator.return()` on that native generator.

### 3. A native generator parked on an in-flight `next()` can't be cancelled

This is the crux, and it's a JavaScript-language constraint:

> When an async generator is suspended at an in-flight `next()` (blocked awaiting
> its upstream source), calling `.return()` on it is **enqueued behind that
> `next()`** and is only processed once the `next()` settles. It does **not**
> interrupt the await, and it does **not** propagate `.return()` to the inner
> `for await` source.

So the close cascade's `iterator.return()` never reached the underlying source.
The source only closed when the client was destroyed (Phase 3) — which Phase 1 was
waiting on. **Circular wait → deadlock.**

Isolated proof (the mechanism in 20 lines):

```ts
let innerReturnCalled = false;
const inner = { [Symbol.asyncIterator]() { return {
  next() { return new Promise(() => {}); },           // never resolves
  return() { innerReturnCalled = true; return Promise.resolve({ done: true }); },
}; } };
async function* gen() { for await (const v of inner) yield v; }
const it = gen(); it.next();                            // in-flight next()
await it.return(undefined);                             // hangs; queued behind next()
// inner.return() called: false   ← never propagated
```

### 4. The linchpin: Repeater `.return()` settles *immediately*

`@repeaterjs/repeater`'s `Repeater.prototype.return()` calls `finish()` and
resolves all pending `next()`s **synchronously** — it does **not** queue like a
native async generator. So a Repeater-backed `ManagedStream` *can* be cancelled
promptly via `.return()`/`.close()` — **but only if the core doesn't bury it under
the `bindSend` native-generator wrapper.** That wrapper defeated prompt
cancellation for every provider, even the ones (iMessage/Slack/WhatsApp) that
already returned cancellable `ManagedStream`s.

### Provider survey (cancellability of each message source)

| Provider | `messages` returns | Source it blocks on | Cancellable by `return()`? |
| --- | --- | --- | --- |
| **terminal** | native `async *` (pre-fix) | in-memory event queue | ❌ native gen — only closed by `destroyClient` |
| **iMessage** (local/remote) | `ManagedStream` (`stream`/`mergeStreams`/`resumableOrderedStream`) | SDK watch / gRPC subscribe | ✅ Repeater — *if* not wrapped |
| **Slack** | `ManagedStream` | per-team events subscribe | ✅ Repeater — *if* not wrapped |
| **WhatsApp** | `ManagedStream` | per-client subscribe | ✅ Repeater — *if* not wrapped |
| **Telegram** | fusor (webhook) | `AsyncQueue` (synchronous `return()`) | ✅ — *if* not wrapped |

Terminal was the only native-generator provider. Everything else was already
cancellable but was being defeated by the wrapper + ordering.

## Why "just reorder `destroyClient` first" is **not** enough

The most tempting fix — run `destroyClient` before/concurrently with stream close
— is insufficient on its own:

- It doesn't fix `ManagedStream` providers cleanly. With `bindSend` still in place,
  their `return()` is still queued; and even if a concurrent `destroyClient` kills
  their socket, `resumableOrderedStream`'s retry loop reconnect-spins (its internal
  `closed` flag is only set by *its own* cleanup, which never runs) instead of
  ending.

So the **stream-consumption rework is required regardless**. The reorder only
changes *when* `destroyClient` runs relative to stream close.

## The fix (what shipped)

Four changes. Files: `src/spectrum.ts`, `src/providers/terminal/index.ts`,
`src/utils/stream.ts`, plus a regression test.

### 1. Remove the native-generator wrappers — `src/spectrum.ts`

`adaptIterable` gained an optional per-item projector so it can do the message
mapping / event annotation itself, eliminating the `bindSend` / `annotatePlatform`
layers. Its pump is now the **only** generator between the source and the stream,
so its cleanup calls `iterator.return()` **directly on the provider's source** —
which settles promptly for a Repeater `ManagedStream` and for the fusor
`AsyncQueue`.

```ts
const adaptIterable = <TIn, TOut = TIn>(
  iterable: AsyncIterable<TIn>,
  project?: (value: TIn, emit: (out: TOut) => Promise<void>) => Promise<void>
): ManagedStream<TOut> => stream<TOut>((emit, end) => { /* pump applies project */ });
```

- `createProviderMessagesStream` → `adaptIterable(raw, (record, emit) => …resolveRecordToMessages…)`
  (preserves group-flatten + per-record span, ordering).
- `createCustomEventStream` → `adaptIterable(providerEvents, (value, emit) => …withSpan + {…value, platform}…)`.

This alone fixes **iMessage / Slack / WhatsApp / Telegram**.

### 2. Make `terminal` cancellable — `src/providers/terminal/index.ts`

`terminal.messages` now returns a Repeater `ManagedStream` (via the `stream()`
util, imported as `managedStream` to avoid the existing local `stream` name)
instead of a native `async *`. It drives `client.events` with an explicit pump,
and its cleanup calls the event-queue iterator's `return()` (which
`makeEventQueue` already implements synchronously). On `stop()`, terminal's stream
now closes promptly via `return()` — **no longer dependent on `destroyClient`** —
and is consistent with every other streaming provider.

The element type is `TerminalInboundMessage` (required `sender`/`space` + the
`replyTo` extra), not the looser `ProviderMessageRecord` (optional
`sender`/`space`), so it satisfies the `messages` contract.

### 3. Keep clean ordering + a bounded safety net — `src/spectrum.ts`

`stopOnce` keeps the **close streams → fusor → destroy** ordering. Phase 1's await
is **bounded** by `STREAM_CLOSE_TIMEOUT_MS` (5 s): start the close, race it against
a timeout, then proceed to fusor close + `destroyClient` (which can unblock a stuck
stream from below), and `await` the residual stream-close at the very end. With (1)
and (2) every current provider closes well under the timeout — the happy path is
unchanged; the timeout only guards a future *uncancellable* provider so `stop()`
can never hang forever.

### 4. Harden `broadcast()` — `src/utils/stream.ts`

So a stalled subscriber can't keep `broadcaster.close()` pending: `close()` now
ends all consumers **immediately** (via `closeConsumers`, without awaiting in-flight
deliveries) and sets `terminated`; the pump bails when `terminated`/`closed`.
`terminated` is the single source of truth that prevents double-ending.

> **Behavior change:** on `stop()`, messages still buffered in a consumer's
> in-flight delivery chain are dropped. The normal EOF path still drains.

## Design note: Plan B vs. the concurrent-teardown alternative

Issue #103's *Expected Behavior* says teardown "should start even when stream
shutdown is still unwinding" — i.e. **concurrent** `destroyClient` (call it
Plan A). The shipped fix (**Plan B**) instead makes streams *independently
cancellable* so the clean ordering works without a deadlock and without a teardown
race.

|  | Plan A (concurrent destroy) | **Plan B (shipped)** |
| --- | --- | --- |
| Fixes deadlock | yes | yes |
| `destroyClient` starts before streams finish closing | yes (even for uncancellable providers) | only after stream close resolves (fast for cancellable providers; bounded for others) |
| Teardown races in-flight stream work | yes | no |
| Requires terminal rewrite | no | yes (done) |

Under Plan B a *well-written* provider's stream self-cancels, so `destroyClient`
starts within milliseconds anyway. The only case where Plan B delays
`destroyClient` is an **uncancellable native-generator provider** that relies on
`destroyClient` to close its source — an anti-pattern Plan B eliminates from
terminal.

## Testing guidance (important)

A regression test must use a **cancellable** provider — return a `ManagedStream`
(or an iterable whose `iterator.return()` actually closes the source), exactly as
the real providers now do. Then `stop()` resolves promptly.

A test that hand-rolls a **native `async *messages`** over a queue with no working
`return()` reproduces the *pre-fix* anti-pattern (the shape we removed from
terminal). Under Plan B such a provider:

- does **not** make `destroyClient` start before stream close — so an assertion
  like "`destroyClient` starts within 1 s" will fail (it starts after the bounded
  ~5 s wait); but
- `stop()` still resolves (bounded + rescued by `destroyClient`), so assert
  **eventual resolution**, not concurrent-teardown timing.

The shipped regression suite (`src/spectrum.shutdown.test.ts`) covers: managed
provider with/without `destroyClient`, multiple providers (mergeStreams), no
subscription, and a native-generator provider (bounded-then-rescued).

## Verification

```bash
bun test packages/core/test/core/spectrum.shutdown.test.ts   # new regression
bun test packages/core/test/core/fusor/webhook.test.ts       # heavy stop()/broadcast user
bun test packages/core/test                                  # full suite (60 pass)
bun run check                                                  # ultracite lint/format
bun x tsc --noEmit -p packages/core/tsconfig.json      # types
```

Manual smoke: a script with `terminal.config()` — subscribe, read one
`[space, msg]`, `break`, `await app.stop()` → prompt exit (sub-second); Ctrl-C
exits before the 3 s hard-exit fallback in `handleSignal`.
