import { describe, expect, it } from "bun:test";
import type { Content } from "@spectrum-ts/core";
import { buildSend } from "@/outbound/message";

// A minimal `app` content with stub accessors — keeps the test off the network
// (the real `app()` would parse the layout from the URL's link metadata).
const appContent = (
  url: string,
  layout: Record<string, unknown> = { caption: "Store", subcaption: "Hi" }
): Content =>
  ({
    type: "app",
    url: () => Promise.resolve(url),
    layout: () => Promise.resolve(layout),
  }) as unknown as Content;

describe("buildSend — app", () => {
  it("sends the bare URL as message content (Discord auto-embeds it)", async () => {
    const spec = await buildSend(appContent("https://example.com/play"));
    expect(spec.files).toBeUndefined();
    expect(spec.payload.content).toBe("https://example.com/play");
  });

  it("ignores the layout — Discord has no mini-app surface", async () => {
    const spec = await buildSend(
      appContent("https://example.com/x", {
        caption: "Title",
        image: new Uint8Array([1, 2, 3]),
      })
    );
    expect(spec.payload.content).toBe("https://example.com/x");
    expect(spec.payload).not.toHaveProperty("embeds");
  });
});
