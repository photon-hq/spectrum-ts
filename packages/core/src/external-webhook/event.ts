// ---------------------------------------------------------------------------
// providerEvent — emit a custom event channel from an external webhook `messages` handler
// ---------------------------------------------------------------------------
//
// A external webhook platform has no long-lived client to stream custom events from, so
// instead of a producer it *declares* each channel as a Zod schema under
// `events` (the key is the channel name) and *emits* per-webhook by returning
// `providerEvent(channel, data)` from `messages`. The external webhook core inspects each
// returned item: a `ProviderEvent` whose `name` is a declared channel routes
// `data` to `spectrum.<channel>`; the reserved `name` "messages" (and any bare
// `ProviderMessageRecord`) routes to the core `spectrum.messages` stream.
//
// Emit is intentionally untyped (a free function, not checked against the
// declared channels) — a pragmatic bridge until the platform model is fully
// external webhook-based. A typo in the channel name is caught at runtime by the core,
// which warns instead of silently dropping.

const PROVIDER_EVENT_BRAND: unique symbol = Symbol.for("spectrum.fusor.event");

/** The reserved channel name that routes back to `spectrum.messages`. */
export const PROVIDER_MESSAGES_CHANNEL = "messages";

export interface ProviderEvent<TName extends string = string, TData = unknown> {
  readonly data: TData;
  readonly name: TName;
  readonly [PROVIDER_EVENT_BRAND]: true;
}

export function providerEvent<TName extends string, TData>(
  name: TName,
  data: TData
): ProviderEvent<TName, TData> {
  return { [PROVIDER_EVENT_BRAND]: true, name, data };
}

export function isProviderEvent(value: unknown): value is ProviderEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [PROVIDER_EVENT_BRAND]?: unknown })[PROVIDER_EVENT_BRAND] ===
      true
  );
}
