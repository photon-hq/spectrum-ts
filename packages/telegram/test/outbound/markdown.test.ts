import { describe, expect, it } from "bun:test";
import { markdownToTelegramHtml } from "@/outbound/markdown";

describe("markdownToTelegramHtml", () => {
  it("maps nested emphasis to Telegram tags", () => {
    expect(markdownToTelegramHtml("**bold _italic_** ~~gone~~")).toBe(
      "<b>bold <i>italic</i></b> <s>gone</s>"
    );
  });

  it("escapes & < > in plain text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d"
    );
  });

  it("escapes code span content inside <code>", () => {
    expect(markdownToTelegramHtml("`a<b&c`")).toBe("<code>a&lt;b&amp;c</code>");
  });

  it("renders a fenced block with a language as <pre><code class>", () => {
    expect(markdownToTelegramHtml("```ts\na < b\n```")).toBe(
      '<pre><code class="language-ts">a &lt; b</code></pre>'
    );
  });

  it("renders a fenced block without a language as bare <pre>", () => {
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("escapes link hrefs in the attribute", () => {
    expect(markdownToTelegramHtml("[docs](https://e.test?a=1&b=2)")).toBe(
      '<a href="https://e.test?a=1&amp;b=2">docs</a>'
    );
  });

  it("renders a bare autolink as plain text for Telegram to auto-link", () => {
    expect(markdownToTelegramHtml("see https://bare.example")).toBe(
      "see https://bare.example"
    );
  });

  it("degrades images to links labeled by alt text", () => {
    expect(markdownToTelegramHtml("![chart](https://i.test/p.png)")).toBe(
      '<a href="https://i.test/p.png">chart</a>'
    );
  });

  it("renders headings as bold blocks", () => {
    expect(markdownToTelegramHtml("# Title\n\nbody")).toBe(
      "<b>Title</b>\n\nbody"
    );
  });

  it("flattens nested blockquotes into one tag", () => {
    expect(markdownToTelegramHtml("> outer\n>> inner")).toBe(
      "<blockquote>outer\ninner</blockquote>"
    );
  });

  it("renders lists as bullet lines with styled inline children", () => {
    expect(markdownToTelegramHtml("- **a**\n- b")).toBe("• <b>a</b>\n• b");
  });

  it("marks task list items with their checkbox state", () => {
    expect(markdownToTelegramHtml("- [x] done\n- [ ] todo")).toBe(
      "• [x] done\n• [ ] todo"
    );
  });

  it("escapes raw HTML instead of passing it through", () => {
    expect(markdownToTelegramHtml("<u>under</u> ok")).toBe(
      "&lt;u&gt;under&lt;/u&gt; ok"
    );
  });

  it("renders tables as escaped <pre> blocks with plain cells", () => {
    expect(
      markdownToTelegramHtml("| h1 | h2 |\n|---|---|\n| **a** | b |")
    ).toBe("<pre>h1 | h2\na | b</pre>");
  });

  it("renders a horizontal rule as a dash line", () => {
    expect(markdownToTelegramHtml("---")).toBe("———");
  });
});
