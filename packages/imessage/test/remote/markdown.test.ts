import { describe, expect, it } from "bun:test";
import { markdownToIMessageText } from "@/remote/markdown";

describe("markdownToIMessageText", () => {
  it("passes plain text through with no ranges", () => {
    expect(markdownToIMessageText("hello")).toEqual({
      text: "hello",
      formatting: [],
    });
  });

  it("maps bold to a range at the correct offset", () => {
    expect(markdownToIMessageText("a **b** c")).toEqual({
      text: "a b c",
      formatting: [{ type: "bold", start: 2, length: 1 }],
    });
  });

  it("maps italic and strikethrough to their range types", () => {
    expect(markdownToIMessageText("*i* ~~gone~~").formatting).toEqual([
      { type: "italic", start: 0, length: 1 },
      { type: "strikethrough", start: 2, length: 4 },
    ]);
  });

  it("counts offsets in UTF-16 code units (emoji are 2)", () => {
    expect(markdownToIMessageText("🎉 **x**")).toEqual({
      text: "🎉 x",
      formatting: [{ type: "bold", start: 3, length: 1 }],
    });
  });

  it("emits overlapping ranges for nested emphasis", () => {
    expect(markdownToIMessageText("***x***").formatting).toEqual([
      { type: "bold", start: 0, length: 1 },
      { type: "italic", start: 0, length: 1 },
    ]);
  });

  it("keeps the outer range whole around a styled inner run", () => {
    expect(markdownToIMessageText("**bold _it_ tail**")).toEqual({
      text: "bold it tail",
      formatting: [
        { type: "bold", start: 0, length: 12 },
        { type: "italic", start: 5, length: 2 },
      ],
    });
  });

  it("coalesces adjacent spans sharing a style into one range", () => {
    // The heading's bold covers both child spans; the italic nests inside.
    expect(markdownToIMessageText("# A *b*")).toEqual({
      text: "A b",
      formatting: [
        { type: "bold", start: 0, length: 3 },
        { type: "italic", start: 2, length: 1 },
      ],
    });
  });

  it("never extends a range across a block separator", () => {
    expect(markdownToIMessageText("# A\n\n# B")).toEqual({
      text: "A\n\nB",
      formatting: [
        { type: "bold", start: 0, length: 1 },
        { type: "bold", start: 3, length: 1 },
      ],
    });
  });

  it("renders headings as bold over exactly the heading text", () => {
    expect(markdownToIMessageText("# Title\n\nbody")).toEqual({
      text: "Title\n\nbody",
      formatting: [{ type: "bold", start: 0, length: 5 }],
    });
  });

  it("renders links as label (url)", () => {
    expect(markdownToIMessageText("[docs](https://d.test)")).toEqual({
      text: "docs (https://d.test)",
      formatting: [],
    });
  });

  it("keeps inline styling on a link label, not its url suffix", () => {
    expect(markdownToIMessageText("[**a**](https://d.test)")).toEqual({
      text: "a (https://d.test)",
      formatting: [{ type: "bold", start: 0, length: 1 }],
    });
  });

  it("renders a bare autolink as the url alone", () => {
    expect(markdownToIMessageText("see https://bare.example")).toEqual({
      text: "see https://bare.example",
      formatting: [],
    });
  });

  it("renders images as alt (url)", () => {
    expect(markdownToIMessageText("![chart](https://i.test/p.png)")).toEqual({
      text: "chart (https://i.test/p.png)",
      formatting: [],
    });
  });

  it("renders code spans as Unicode monospace with no ranges", () => {
    expect(markdownToIMessageText("`npm install spectrum-ts`")).toEqual({
      text: "𝚗𝚙𝚖 𝚒𝚗𝚜𝚝𝚊𝚕𝚕 𝚜𝚙𝚎𝚌𝚝𝚛𝚞𝚖-𝚝𝚜",
      formatting: [],
    });
  });

  it("maps all ASCII alphanumerics and keeps other characters", () => {
    expect(markdownToIMessageText("`Ab9 <&_>`").text).toBe("𝙰𝚋𝟿 <&_>");
  });

  it("renders fenced blocks as monospace regardless of language", () => {
    expect(markdownToIMessageText("```ts\na < b\n```").text).toBe("𝚊 < 𝚋");
  });

  it("keeps range offsets correct after astral monospace characters", () => {
    // Each monospace character is 2 UTF-16 units: "𝚊𝚋 " spans 5 units.
    expect(markdownToIMessageText("`ab` **c**")).toEqual({
      text: "𝚊𝚋 c",
      formatting: [{ type: "bold", start: 5, length: 1 }],
    });
  });

  it("renders lists as bullet lines with styled inline children", () => {
    expect(markdownToIMessageText("- **a**\n- b")).toEqual({
      text: "• a\n• b",
      formatting: [{ type: "bold", start: 2, length: 1 }],
    });
  });

  it("keeps ordered list numbering from the start value", () => {
    expect(markdownToIMessageText("3. x\n4. y").text).toBe("3. x\n4. y");
  });

  it("marks task list items with their checkbox state", () => {
    expect(markdownToIMessageText("- [x] done\n- [ ] todo").text).toBe(
      "• [x] done\n• [ ] todo"
    );
  });

  it("indents nested list items under their parent", () => {
    expect(markdownToIMessageText("- a\n  - b").text).toBe("• a\n  • b");
  });

  it("prefixes blockquote lines without styling the marker", () => {
    expect(markdownToIMessageText("> **q**")).toEqual({
      text: "> q",
      formatting: [{ type: "bold", start: 2, length: 1 }],
    });
  });

  it("separates blockquote paragraphs with a bare marker line", () => {
    expect(markdownToIMessageText("> a\n>\n> b").text).toBe("> a\n>\n> b");
  });

  it("renders tables as pipe-separated rows with styled cells", () => {
    expect(
      markdownToIMessageText("| h1 | h2 |\n|---|---|\n| **a** | b |")
    ).toEqual({
      text: "h1 | h2\na | b",
      formatting: [{ type: "bold", start: 8, length: 1 }],
    });
  });

  it("renders horizontal rules as a dash line", () => {
    expect(markdownToIMessageText("a\n\n---\n\nb").text).toBe("a\n\n———\n\nb");
  });

  it("keeps raw HTML literal", () => {
    expect(markdownToIMessageText("<u>under</u> ok")).toEqual({
      text: "<u>under</u> ok",
      formatting: [],
    });
  });

  it("keeps a bold range across a soft line break", () => {
    expect(markdownToIMessageText("**line one\nline two**")).toEqual({
      text: "line one\nline two",
      formatting: [{ type: "bold", start: 0, length: 17 }],
    });
  });

  it("trims leading blank lines without shifting range starts", () => {
    expect(markdownToIMessageText("\n\n# A")).toEqual({
      text: "A",
      formatting: [{ type: "bold", start: 0, length: 1 }],
    });
  });

  it("renders whitespace-only markdown to an empty result", () => {
    expect(markdownToIMessageText("   ")).toEqual({
      text: "",
      formatting: [],
    });
  });
});
