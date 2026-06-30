import {
  createInstrumentedFetch,
  type FetchSpanOptions,
} from "@photon-ai/otel";

/**
 * Build a fetch that traces spectrum's OWN outbound HTTP: each request through
 * the returned fetch emits a CLIENT span (tagged with `peer.service`) and
 * carries W3C trace context downstream. It never mutates `globalThis.fetch`, so
 * a consumer's unrelated requests stay untouched.
 *
 * The base delegates to `globalThis.fetch` at call time — deliberately NOT
 * `createInstrumentedFetch(globalThis.fetch, …)`, which would capture the
 * original and bypass a test's `spyOn(globalThis, "fetch")`. When telemetry is
 * off (no `setupOtel`), the tracer is a no-op and this is a transparent
 * pass-through. Create one per module: `const tf = tracedFetch("…")`.
 *
 * Pass `redactUrl` to strip secrets from a request URL before it is recorded as
 * the span's `url.full` (e.g. a token in the path or query); the real request
 * still uses the original URL. Pair with `sanitizeUrl` for semconv-style query
 * redaction.
 */
export const tracedFetch = (
  peerService: string,
  options?: Pick<FetchSpanOptions, "ignore" | "redactUrl">
): typeof fetch =>
  createInstrumentedFetch(
    // Cast: the delegating lambda lacks fetch's `preconnect` static (which the
    // instrumentation never calls), so it isn't structurally `typeof fetch`.
    ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      globalThis.fetch(input, init)) as typeof fetch,
    { attributes: { "peer.service": peerService }, ...options }
  );
