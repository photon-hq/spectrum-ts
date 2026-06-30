import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { tracedFetch } from "@/utils/instrumented-fetch";

describe("tracedFetch", () => {
  afterEach(() => {
    mock.restore();
  });

  it("delegates to a globalThis.fetch spy installed AFTER the wrapper is built", async () => {
    // Build the wrapper first — mirrors creation at module-eval time, before a
    // test installs its fetch mock. Capturing globalThis.fetch here instead of
    // delegating would silently bypass the spy.
    const tf = tracedFetch("test-peer");
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch
    );

    const res = await tf("https://example.test/thing");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("ok");
  });

  it("forwards method, headers, and signal to the delegated fetch", async () => {
    const tf = tracedFetch("test-peer");
    let seenInit: RequestInit | undefined;
    spyOn(globalThis, "fetch").mockImplementation((async (
      _input: unknown,
      init?: RequestInit
    ) => {
      seenInit = init;
      return new Response("ok");
    }) as unknown as typeof fetch);

    const controller = new AbortController();
    await tf("https://example.test/x", {
      method: "POST",
      headers: { "x-test": "1" },
      signal: controller.signal,
    });

    expect(seenInit?.method).toBe("POST");
    // The wrapper merges headers into a Headers object (and would inject
    // traceparent when telemetry is on), so read via the Headers API.
    expect(new Headers(seenInit?.headers).get("x-test")).toBe("1");
    expect(seenInit?.signal).toBe(controller.signal);
  });
});
