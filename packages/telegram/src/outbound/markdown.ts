import { renderInlineTokens as inlinePlainText } from "@spectrum-ts/core/authoring";
import { Marked, type MarkedToken, type Token, type Tokens } from "marked";

// Private instance: immune to host apps reconfiguring the global `marked`
// singleton via `marked.use()` / `marked.setOptions()`.
const markdownLexer = new Marked();

const BULLET = "• ";
const HR_LINE = "———";
const NESTED_LIST_INDENT = "  ";
const BLOCK_SEPARATOR = "\n\n";
const TABLE_CELL_SEPARATOR = " | ";
const DEFAULT_LIST_START = 1;

const AMP_PATTERN = /&/g;
const LT_PATTERN = /</g;
const GT_PATTERN = />/g;
const QUOTE_PATTERN = /"/g;

const escapeHtml = (value: string): string =>
  value
    .replace(AMP_PATTERN, "&amp;")
    .replace(LT_PATTERN, "&lt;")
    .replace(GT_PATTERN, "&gt;");

const escapeAttribute = (value: string): string =>
  escapeHtml(value).replace(QUOTE_PATTERN, "&quot;");

// Same narrowing dodge as utils/markdown.ts: `Tokens.Generic`'s index
// signature defeats discriminated-union narrowing on `Token`.
const asMarkedToken = (token: Token): MarkedToken => token as MarkedToken;

const checkboxPrefix = (item: Tokens.ListItem): string => {
  if (!item.task) {
    return "";
  }
  return item.checked ? "[x] " : "[ ] ";
};

const listMarker = (list: Tokens.List, index: number): string => {
  if (!list.ordered) {
    return BULLET;
  }
  const start = list.start === "" ? DEFAULT_LIST_START : list.start;
  return `${start + index}. `;
};

const renderLink = (token: Tokens.Link): string => {
  // A bare autolink lexes with its label equal to its href — emit the plain
  // url and let the Telegram client auto-link it.
  if (token.text === token.href) {
    return escapeHtml(token.href);
  }
  return `<a href="${escapeAttribute(token.href)}">${renderInlineTokens(token.tokens)}</a>`;
};

// Telegram HTML has no <img>; an image degrades to a link labeled by its
// alt text (or the bare url when there is none).
const renderImage = (token: Tokens.Image): string =>
  `<a href="${escapeAttribute(token.href)}">${escapeHtml(token.text || token.href)}</a>`;

const renderText = (token: Tokens.Text): string => {
  if (token.tokens) {
    return renderInlineTokens(token.tokens);
  }
  // `escaped` is set when the lexer already entity-encoded the text (raw
  // HTML blocks); escaping again would double-encode.
  return token.escaped ? token.text : escapeHtml(token.text);
};

const renderInlineToken = (token: MarkedToken): string => {
  switch (token.type) {
    case "strong":
      return `<b>${renderInlineTokens(token.tokens)}</b>`;
    case "em":
      return `<i>${renderInlineTokens(token.tokens)}</i>`;
    case "del":
      return `<s>${renderInlineTokens(token.tokens)}</s>`;
    case "codespan":
      return `<code>${escapeHtml(token.text)}</code>`;
    case "br":
      return "\n";
    case "link":
      return renderLink(token);
    case "image":
      return renderImage(token);
    case "escape":
      return escapeHtml(token.text);
    case "text":
      return renderText(token);
    // Raw HTML in markdown source renders literally, never passes through:
    // a tag outside Telegram's whitelist would 400 the whole Bot API call
    // (a TelegramApiError, not UnsupportedError — the plain-text fallback
    // would not catch it). Escaping makes invalid output impossible.
    case "html":
      return escapeHtml(token.text);
    // Task-item checkboxes are rendered from `ListItem.task`/`checked`.
    case "checkbox":
      return "";
    default:
      return "raw" in token ? escapeHtml(String(token.raw)) : "";
  }
};

const renderInlineTokens = (tokens: Token[]): string => {
  let out = "";
  for (const token of tokens) {
    out += renderInlineToken(asMarkedToken(token));
  }
  return out;
};

const renderCode = (token: Tokens.Code): string => {
  if (token.lang) {
    return `<pre><code class="language-${escapeAttribute(token.lang)}">${escapeHtml(token.text)}</code></pre>`;
  }
  return `<pre>${escapeHtml(token.text)}</pre>`;
};

// Telegram rejects nested <blockquote> tags, so inner quotes are flattened
// into the single enclosing tag as plain lines.
const renderQuoteBody = (tokens: Token[]): string => {
  const blocks: string[] = [];
  for (const token of tokens) {
    const marked = asMarkedToken(token);
    const rendered =
      marked.type === "blockquote"
        ? renderQuoteBody(marked.tokens)
        : renderBlockToken(marked);
    if (rendered) {
      blocks.push(rendered);
    }
  }
  return blocks.join("\n");
};

// Telegram has no list markup; items become `•`/`1.` text lines whose inline
// children keep their HTML styling. Blocks inside an item stack on single
// newlines, continuation lines indented under the marker.
const renderList = (list: Tokens.List): string => {
  const lines: string[] = [];
  for (const [index, item] of list.items.entries()) {
    const prefix = `${listMarker(list, index)}${checkboxPrefix(item)}`;
    const blocks: string[] = [];
    for (const token of item.tokens) {
      const rendered = renderBlockToken(asMarkedToken(token));
      if (rendered) {
        blocks.push(rendered);
      }
    }
    const [first = "", ...rest] = blocks.join("\n").split("\n");
    lines.push(`${prefix}${first}`);
    for (const line of rest) {
      lines.push(`${NESTED_LIST_INDENT}${line}`);
    }
  }
  return lines.join("\n");
};

// Telegram has no table markup; a <pre> block keeps columns aligned in
// monospace. Cells render as plain text (inline HTML inside <pre> shows
// literally, so styling is dropped rather than leaked as markup).
const renderTable = (table: Tokens.Table): string => {
  const renderRow = (cells: Tokens.TableCell[]): string =>
    cells
      .map((cell) => inlinePlainText(cell.tokens))
      .join(TABLE_CELL_SEPARATOR);
  const lines = [renderRow(table.header)];
  for (const row of table.rows) {
    lines.push(renderRow(row));
  }
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
};

const renderBlockToken = (token: MarkedToken): string => {
  switch (token.type) {
    // Telegram has no headings; bold is the conventional stand-in.
    case "heading":
      return `<b>${renderInlineTokens(token.tokens)}</b>`;
    case "paragraph":
      return renderInlineTokens(token.tokens);
    case "code":
      return renderCode(token);
    case "blockquote":
      return `<blockquote>${renderQuoteBody(token.tokens)}</blockquote>`;
    case "list":
      return renderList(token);
    case "table":
      return renderTable(token);
    case "hr":
      return HR_LINE;
    case "space":
    case "def":
      return "";
    default:
      return renderInlineToken(token);
  }
};

/**
 * Render standard markdown (CommonMark + GFM) to Telegram-flavored HTML for
 * `parse_mode: "HTML"` sends. Only tags Telegram accepts are emitted; all
 * text (including raw HTML in the source) is entity-escaped so the output
 * can never fail Bot API parsing.
 */
export const markdownToTelegramHtml = (markdown: string): string => {
  const blocks: string[] = [];
  for (const token of markdownLexer.lexer(markdown)) {
    const rendered = renderBlockToken(asMarkedToken(token));
    if (rendered) {
      blocks.push(rendered);
    }
  }
  return blocks.join(BLOCK_SEPARATOR).trim();
};
