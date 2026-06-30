import { describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import { setupOtel } from "@photon-ai/otel";

// Regression guard for the client-facing-SDK conflict fix: scoped mode
// (register: false) must NOT register spectrum's providers as the process-global
// tracer/logger providers, or it would clobber a consumer's own OpenTelemetry
// (global registration is first-writer-wins and silently drops the loser).
describe("setupOtel scoped mode (register: false)", () => {
  it("leaves the global tracer provider untouched", () => {
    const globalBefore = trace.getTracerProvider();

    const handle = setupOtel({
      serviceName: "spectrum-ts-test",
      register: false,
    });

    // The global provider is the same object as before the call...
    expect(trace.getTracerProvider()).toBe(globalBefore);
    // ...and spectrum's private provider is held separately, not registered.
    expect(handle.tracerProvider).not.toBe(trace.getTracerProvider());
  });
});
