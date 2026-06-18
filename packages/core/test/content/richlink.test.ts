import { describe, expect, it } from "bun:test";
import { asRichlink } from "@/content/richlink";

describe("asRichlink — prefetched metadata", () => {
  it("resolves supplied title/summary without a network fetch", async () => {
    const link = asRichlink({
      url: "https://x.test/post",
      title: "Title",
      summary: "Summary",
    });

    expect(link.type).toBe("richlink");
    expect(link.url).toBe("https://x.test/post");
    expect(await link.title()).toBe("Title");
    expect(await link.summary()).toBe("Summary");
    // No cover supplied → accessor resolves undefined (no image download).
    expect(await link.cover()).toBeUndefined();
  });

  it("normalizes empty/whitespace metadata to undefined", async () => {
    const link = asRichlink({
      url: "https://x.test/post",
      title: "   ",
      summary: "",
    });

    expect(await link.title()).toBeUndefined();
    expect(await link.summary()).toBeUndefined();
  });

  it("builds a lazy cover from the supplied image url", async () => {
    const link = asRichlink({
      url: "https://x.test/post",
      cover: { imageUrl: "https://x.test/cover.png", mimeType: "image/png" },
    });

    const cover = await link.cover();
    expect(cover?.mimeType).toBe("image/png");
    expect(typeof cover?.read).toBe("function");
    expect(typeof cover?.stream).toBe("function");
  });

  it("is selected whenever any metadata key is present, even if undefined", async () => {
    // `title` key present but undefined still chooses the no-fetch path.
    const link = asRichlink({ url: "https://x.test/post", title: undefined });
    expect(await link.title()).toBeUndefined();
  });
});
