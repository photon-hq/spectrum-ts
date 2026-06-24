import { describe, expect, it } from "bun:test";
import {
  markdownToPlainText,
  markdownToSlack,
  markdownToWhatsapp,
} from "@/utils/markdown";

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

describe("markdownToSlack", () => {
  it("converts strong, em, and del to slack mrkdwn style", () => {
    expect(markdownToSlack("**bold _italic_ ~~strike~~**")).toBe(
      "*bold _italic_ ~strike~*"
    );
  });

  it("converts codespan", () => {
    expect(markdownToSlack("run `a < b` now")).toBe("run `a < b` now");
  });

  it("escapes Slack special characters &, <, and >", () => {
    expect(markdownToSlack("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("converts markdown links to Slack mrkdwn links", () => {
    expect(markdownToSlack("see [docs](https://d.test)")).toBe(
      "see <https://d.test|docs>"
    );
    expect(markdownToSlack("see [https://d.test](https://d.test)")).toBe(
      "see <https://d.test>"
    );
  });

  it("converts headings to bold text", () => {
    expect(markdownToSlack("# Title\n\nbody")).toBe("*Title*\n\nbody");
  });

  it("converts lists and blockquotes", () => {
    expect(markdownToSlack("- item 1\n- item 2")).toBe("• item 1\n• item 2");
    expect(markdownToSlack("> quote line")).toBe("> quote line");
  });
});

describe("markdownToWhatsapp", () => {
  it("converts strong, em, and del to whatsapp style", () => {
    expect(markdownToWhatsapp("**bold _italic_ ~~strike~~**")).toBe(
      "*bold _italic_ ~strike~*"
    );
  });

  it("converts codespan", () => {
    expect(markdownToWhatsapp("run `a < b` now")).toBe("run `a < b` now");
  });

  it("does not escape HTML entities for whatsapp", () => {
    expect(markdownToWhatsapp("a & b < c > d")).toBe("a & b < c > d");
  });

  it("degrades markdown links to label (url) for whatsapp", () => {
    expect(markdownToWhatsapp("see [docs](https://d.test)")).toBe(
      "see docs (https://d.test)"
    );
    expect(markdownToWhatsapp("see [https://d.test](https://d.test)")).toBe(
      "see https://d.test"
    );
  });

  it("converts headings to bold text", () => {
    expect(markdownToWhatsapp("# Title\n\nbody")).toBe("*Title*\n\nbody");
  });
});
