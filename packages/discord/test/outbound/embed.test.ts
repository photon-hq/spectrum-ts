import { describe, expect, it } from "bun:test";
import { attachment, type Content } from "@spectrum-ts/core";
import { asReply } from "@spectrum-ts/core/authoring";
import { DISCORD_PLATFORM } from "@/config";
import { asEmbed, embed, isEmbed } from "@/content/embed";
import { buildSend, embedToSpec } from "@/outbound/message";

describe("asEmbed", () => {
  it("wraps a single embed and optional text, tagged for Discord", () => {
    expect(asEmbed({ title: "x" }, { content: "hi" })).toEqual({
      type: "embed",
      __platform: "discord",
      embeds: [{ title: "x" }],
      content: "hi",
    });
  });

  it("tags __platform with the provider's registered name so dispatch does not skip it", () => {
    // The dispatch guard (platform/build.ts) compares this tag against the
    // provider's definePlatform name with a strict, case-sensitive `!==`; if they
    // drift (e.g. "Discord" vs "discord") every embed() send is silently dropped.
    expect(asEmbed({ title: "x" }).__platform).toBe(DISCORD_PLATFORM);
  });

  it("accepts an array of embeds without text", () => {
    const value = asEmbed([{ title: "a" }, { title: "b" }]);
    expect(value.embeds).toEqual([{ title: "a" }, { title: "b" }]);
    expect(value).not.toHaveProperty("content");
  });

  it("rejects an empty list", () => {
    expect(() => asEmbed([])).toThrow("at least one embed");
  });

  it("rejects more than 10 embeds", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ title: `${i}` }));
    expect(() => asEmbed(eleven)).toThrow("at most 10 embeds");
  });
});

describe("asEmbed — Discord limit validation", () => {
  it("rejects an over-long title with a precise message", () => {
    expect(() => asEmbed({ title: "x".repeat(257) })).toThrow(
      "Embed 1: title is 257 characters; Discord's limit is 256."
    );
  });

  it("rejects an over-long description", () => {
    expect(() => asEmbed({ description: "x".repeat(4097) })).toThrow(
      "description is 4097 characters; Discord's limit is 4096"
    );
  });

  it("rejects more than 25 fields", () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({
      name: `${i}`,
      value: "v",
    }));
    expect(() => asEmbed({ fields })).toThrow(
      "has 26 fields; Discord allows at most 25"
    );
  });

  it("rejects an over-long field value, pointing at the field", () => {
    expect(() =>
      asEmbed({ fields: [{ name: "n", value: "v".repeat(1025) }] })
    ).toThrow("field 1 value is 1025 characters; Discord's limit is 1024");
  });

  it("rejects footer / author overflow", () => {
    expect(() => asEmbed({ footer: { text: "x".repeat(2049) } })).toThrow(
      "footer text is 2049 characters"
    );
    expect(() => asEmbed({ author: { name: "x".repeat(257) } })).toThrow(
      "author name is 257 characters"
    );
  });

  it("rejects exceeding the 6000-character combined total across embeds", () => {
    expect(() =>
      asEmbed([
        { description: "x".repeat(4000) },
        { description: "y".repeat(4000) },
      ])
    ).toThrow("total 8000 characters; Discord allows at most 6000");
  });

  it("rejects a non-integer / out-of-range color with a hex-string hint", () => {
    expect(() => asEmbed({ color: -1 })).toThrow("not a hex string");
    expect(() => asEmbed({ color: 0x1_00_00_00 })).toThrow("color must be");
    // A valid 24-bit integer color passes through untouched.
    expect(asEmbed({ color: 0x58_65_f2 }).embeds[0]?.color).toBe(0x58_65_f2);
  });
});

describe("embed builder", () => {
  it("builds Discord-scoped embed content", async () => {
    // `build()` is typed `Promise<Content>` (the universal union); `embed` is a
    // Discord-scoped type outside it, so widen to compare the runtime shape.
    const built: unknown = await embed(
      { title: "x" },
      { content: "hi" }
    ).build();
    expect(built).toEqual({
      type: "embed",
      __platform: "discord",
      embeds: [{ title: "x" }],
      content: "hi",
    });
  });

  it("validates eagerly at construction (oversize list throws before build)", () => {
    const twelve = Array.from({ length: 12 }, () => ({ title: "x" }));
    expect(() => embed(twelve)).toThrow("at most 10 embeds");
  });
});

describe("isEmbed", () => {
  it("is true for embed content", () => {
    expect(isEmbed(asEmbed({ title: "x" }))).toBe(true);
  });

  it("is false for plain content", () => {
    expect(isEmbed({ type: "text", text: "hi" })).toBe(false);
  });
});

describe("embedToSpec", () => {
  it("maps embeds + text into one message-create body", async () => {
    const spec = await embedToSpec(
      asEmbed([{ title: "a" }, { title: "b" }], { content: "see 👇" })
    );
    expect(spec.files).toBeUndefined();
    expect(spec.payload).toEqual({
      content: "see 👇",
      embeds: [{ title: "a" }, { title: "b" }],
    });
  });

  it("omits content when no text was given", async () => {
    const spec = await embedToSpec(asEmbed({ title: "a" }));
    expect(spec.payload).not.toHaveProperty("content");
    expect(spec.payload.embeds).toEqual([{ title: "a" }]);
  });
});

describe("embed — attachment:// files", () => {
  const chart = () =>
    attachment(Buffer.from([1, 2, 3]), {
      name: "chart.png",
      mimeType: "image/png",
    });

  it("uploads a referenced file as a multipart part of the same message", async () => {
    const built = await embed(
      { image: { url: "attachment://chart.png" } },
      { files: [chart()] }
    ).build();
    const spec = await buildSend(built as unknown as Content);
    expect(spec.files).toEqual([
      {
        bytes: Buffer.from([1, 2, 3]),
        filename: "chart.png",
        contentType: "image/png",
      },
    ]);
    expect(spec.payload.embeds).toEqual([
      { image: { url: "attachment://chart.png" } },
    ]);
  });

  it("rejects a reference with no matching file", () => {
    expect(
      embed({ image: { url: "attachment://missing.png" } }).build()
    ).rejects.toThrow('no file named "missing.png"');
  });

  it("rejects non-attachment files", () => {
    expect(
      embed(
        { image: { url: "attachment://x.png" } },
        { files: [{ build: async () => ({ type: "text", text: "x" }) }] }
      ).build()
    ).rejects.toThrow('must be attachment(...) content (got "text")');
  });
});

describe("embed — nested in reply / buildSend", () => {
  it("buildSend maps a top-level embed directly", async () => {
    const spec = await buildSend(
      asEmbed([{ title: "a" }], { content: "see" }) as unknown as Content
    );
    expect(spec.payload).toEqual({ content: "see", embeds: [{ title: "a" }] });
  });

  it("reply(embed) carries the embed plus message_reference in one body", async () => {
    const reply = asReply({
      // embed is Discord-scoped (outside the BaseContent union) but valid as
      // reply inner content at runtime — `isContent` accepts it.
      content: asEmbed({ title: "hi" }) as never,
      target: { id: "999", content: { type: "text", text: "x" } } as never,
    });
    const spec = await buildSend(reply);
    expect(spec.payload.embeds).toEqual([{ title: "hi" }]);
    expect(spec.payload.message_reference).toEqual({ message_id: "999" });
  });
});
