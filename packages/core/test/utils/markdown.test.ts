import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "@/utils/markdown";

describe("markdownToPlainText", () => {
  it("strips nested emphasis markers", () => {
    expect(markdownToPlainText("**bold _italic_ ~~gone~~**")).toBe(
      "bold italic gone"
    );
  });

  it("keeps code span text verbatim, without entity encoding", () => {
    expect(markdownToPlainText("run `a < b & c` now")).toBe(
      "run a < b & c now"
    );
  });

  it("keeps fenced code blocks verbatim", () => {
    expect(markdownToPlainText("```ts\nconst ok = a < b;\n```")).toBe(
      "const ok = a < b;"
    );
  });

  it("renders links as label (url)", () => {
    expect(markdownToPlainText("see [docs](https://d.test)")).toBe(
      "see docs (https://d.test)"
    );
  });

  it("renders a bare autolink as the url alone", () => {
    expect(markdownToPlainText("see https://d.test")).toBe(
      "see https://d.test"
    );
  });

  it("renders images as alt (url), or the url when alt is empty", () => {
    expect(markdownToPlainText("![chart](https://i.test/p.png)")).toBe(
      "chart (https://i.test/p.png)"
    );
    expect(markdownToPlainText("![](https://i.test/p.png)")).toBe(
      "https://i.test/p.png"
    );
  });

  it("renders unordered lists with bullets", () => {
    expect(markdownToPlainText("- one\n- two")).toBe("• one\n• two");
  });

  it("honors the start number of ordered lists", () => {
    expect(markdownToPlainText("3. three\n4. four")).toBe("3. three\n4. four");
  });

  it("indents nested lists under their parent item", () => {
    expect(markdownToPlainText("- a\n  - b")).toBe("• a\n  • b");
  });

  it("marks task list items with their checkbox state", () => {
    expect(markdownToPlainText("- [x] done\n- [ ] todo")).toBe(
      "• [x] done\n• [ ] todo"
    );
  });

  it("renders headings as their own undecorated block", () => {
    expect(markdownToPlainText("# Title\n\nbody")).toBe("Title\n\nbody");
  });

  it("prefixes blockquote lines, flattening nesting as quoted quotes", () => {
    expect(markdownToPlainText("> outer\n>> inner")).toBe(
      "> outer\n>\n> > inner"
    );
  });

  it("renders a horizontal rule as a dash line", () => {
    expect(markdownToPlainText("above\n\n---\n\nbelow")).toBe(
      "above\n\n———\n\nbelow"
    );
  });

  it("renders tables as pipe-joined rows", () => {
    expect(markdownToPlainText("| h1 | h2 |\n|---|---|\n| **a** | b |")).toBe(
      "h1 | h2\na | b"
    );
  });

  it("keeps raw HTML literal", () => {
    expect(markdownToPlainText("<u>under</u> ok")).toBe("<u>under</u> ok");
  });

  it("renders hard line breaks as newlines", () => {
    expect(markdownToPlainText("line  \nbreak")).toBe("line\nbreak");
  });

  it("separates blocks with a blank line", () => {
    expect(markdownToPlainText("one\n\ntwo")).toBe("one\n\ntwo");
  });
});
