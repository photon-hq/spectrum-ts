// ---------------------------------------------------------------------------
// fusorEvent — emit a custom event channel from a fusor `messages` handler
// ---------------------------------------------------------------------------
//
// A fusor platform has no long-lived client to stream custom events from, so
// instead of a producer it *declares* each channel as a Zod schema under
// `events` (the key is the channel name) and *emits* per-webhook by returning
// `fusorEvent(channel, data)` from `messages`. The fusor core inspects each
// returned item: a `FusorEvent` whose `name` is a declared channel routes
// `data` to `spectrum.<channel>`; the reserved `name` "messages" (and any bare
// `ProviderMessageRecord`) routes to the core `spectrum.messages` stream.
//
// Emit is intentionally untyped (a free function, not checked against the
// declared channels) — a pragmatic bridge until the platform model is fully
// fusor-based. A typo in the channel name is caught at runtime by the core,
// which warns instead of silently dropping.

const FUSOR_EVENT_BRAND: unique symbol = Symbol.for("spectrum.fusor.event");

/** The reserved channel name that routes back to `spectrum.messages`. */
export const FUSOR_MESSAGES_CHANNEL = "messages";

export interface FusorEvent<TName extends string = string, TData = unknown> {
  readonly data: TData;
  readonly name: TName;
  readonly [FUSOR_EVENT_BRAND]: true;
}

export function fusorEvent<TName extends string, TData>(
  name: TName,
  data: TData
): FusorEvent<TName, TData> {
  return { [FUSOR_EVENT_BRAND]: true, name, data };
}

export function isFusorEvent(value: unknown): value is FusorEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [FUSOR_EVENT_BRAND]?: unknown })[FUSOR_EVENT_BRAND] === true
  );
}
