import { describe, expect, it, mock } from "bun:test";
import type { LinkMetadata } from "@/utils/link-metadata";

// `app`'s layout is parsed from the URL's link metadata, so stub the network
// layer. Registering the module mock before importing `@/content/app` means
// the builder closes over these mocks instead of `open-graph-scraper` / fetch.
const DEFAULT_METADATA: LinkMetadata = {
  siteName: "DoorDash",
  title: "7-Eleven (527 Sutter Street)",
  summary: "Convenience, delivered",
  image: { url: "https://img.example/cover.png", mimeType: "image/png" },
};

// JPEG magic bytes (FF D8) — `app` keeps the image only if it is real JPEG.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const fetchLinkMetadata = mock(
  (_url: string): Promise<LinkMetadata> => Promise.resolve(DEFAULT_METADATA)
);
const fetchImage = mock((_url: string) =>
  Promise.resolve({ data: JPEG_BYTES, mimeType: "image/jpeg" })
);

mock.module("@/utils/link-metadata", () => ({ fetchLinkMetadata, fetchImage }));

const { app } = await import("@/content/app");

const buildApp = async (url: Parameters<typeof app>[0]) => {
  const content = await app(url).build();
  if (content.type !== "app") {
    throw new Error(`expected app content, got ${content.type}`);
  }
  return content;
};

describe("app content — consumable url", () => {
  it("resolves a string url", async () => {
    const content = await buildApp("https://example.com/store");
    expect(content.type).toBe("app");
    expect(await content.url()).toBe("https://example.com/store");
  });

  it("resolves a promise url", async () => {
    const content = await buildApp(Promise.resolve("https://example.com/p"));
    expect(await content.url()).toBe("https://example.com/p");
  });

  it("resolves a thunk url and memoizes it (called once)", async () => {
    const thunk = mock(() => "https://example.com/x");
    const content = await buildApp(thunk);
    expect(await content.url()).toBe("https://example.com/x");
    expect(await content.url()).toBe("https://example.com/x");
    expect(thunk).toHaveBeenCalledTimes(1);
  });
});

describe("app content — layout parsed from url", () => {
  it("uses the page title as the caption, with site name overlaid on the banner", async () => {
    fetchLinkMetadata.mockClear();
    fetchImage.mockClear();
    const content = await buildApp("https://example.com/store");
    const layout = await content.layout();
    expect(layout.caption).toBe("7-Eleven (527 Sutter Street)");
    expect(layout.subcaption).toBe("Convenience, delivered");
    expect(layout.imageTitle).toBe("DoorDash");
    expect(layout.image).toEqual(JPEG_BYTES);
  });

  it("routes the og:image through the JPEG proxy", async () => {
    fetchImage.mockClear();
    const content = await buildApp("https://example.com/store");
    await content.layout();
    const requested = fetchImage.mock.calls[0]?.[0] as string;
    expect(requested).toContain("wsrv.nl");
    expect(requested).toContain("output=jpg");
    expect(requested).toContain(
      encodeURIComponent("https://img.example/cover.png")
    );
  });

  it("drops the image when the proxy returns non-JPEG bytes", async () => {
    // PNG magic bytes — not JPEG, so the card must not embed them.
    fetchImage.mockResolvedValueOnce({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
    });
    const content = await buildApp("https://example.com/store");
    const layout = await content.layout();
    expect(layout.image).toBeUndefined();
    expect(layout.imageTitle).toBeUndefined();
    expect(layout.caption).toBe("7-Eleven (527 Sutter Street)");
  });

  it("shares one memoized metadata fetch across url() and layout()", async () => {
    fetchLinkMetadata.mockClear();
    fetchImage.mockClear();
    const content = await buildApp("https://example.com/store");
    await content.url();
    await content.layout();
    await content.layout();
    expect(fetchLinkMetadata).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("falls back to the www-stripped host when the page has no metadata", async () => {
    fetchLinkMetadata.mockResolvedValueOnce({});
    const content = await buildApp("https://www.store.example.com/deep/path");
    const layout = await content.layout();
    expect(layout.caption).toBe("store.example.com");
    expect(layout.subcaption).toBeUndefined();
    expect(layout.image).toBeUndefined();
    expect(layout.imageTitle).toBeUndefined();
  });

  it("omits the image (and imageTitle) when the image fetch fails", async () => {
    fetchLinkMetadata.mockResolvedValueOnce({
      title: "Title",
      summary: "Summary",
      image: { url: "https://img.example/broken.png" },
    });
    fetchImage.mockRejectedValueOnce(new Error("network down"));
    const content = await buildApp("https://example.com/store");
    const layout = await content.layout();
    expect(layout.caption).toBe("Title");
    expect(layout.subcaption).toBe("Summary");
    expect(layout.image).toBeUndefined();
    expect(layout.imageTitle).toBeUndefined();
  });
});
