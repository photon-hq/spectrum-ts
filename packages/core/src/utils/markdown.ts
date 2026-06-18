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

// `Tokens.Generic`'s string index signature defeats discriminated-union
// narrowing on `Token`, so walkers assert down to `MarkedToken` once and
// let the default case absorb generic/extension tokens via `raw`.
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
  // A bare autolink lexes with its label equal to its href — render the
  // url alone instead of doubling it as "url (url)".
  if (token.text === token.href) {
    return token.href;
  }
  return `${renderInlineTokens(token.tokens)} (${token.href})`;
};

const renderImage = (token: Tokens.Image): string =>
  token.text ? `${token.text} (${token.href})` : token.href;

const renderInlineToken = (token: MarkedToken): string => {
  switch (token.type) {
    case "strong":
    case "em":
    case "del":
      return renderInlineTokens(token.tokens);
    case "codespan":
      return token.text;
    case "br":
      return "\n";
    case "link":
      return renderLink(token);
    case "image":
      return renderImage(token);
    case "escape":
      return token.text;
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens) : token.text;
    // Raw HTML in markdown source stays literal — plain text has no markup.
    case "html":
      return token.text;
    // Task-item checkboxes are rendered from `ListItem.task`/`checked`.
    case "checkbox":
      return "";
    default:
      return "raw" in token ? String(token.raw) : "";
  }
};

/**
 * Render a run of inline markdown tokens (a paragraph's or table cell's
 * children) to plain text. Package-internal: platform renderers reuse it
 * where their native format has no inline markup (e.g. Telegram tables).
 */
export const renderInlineTokens = (tokens: Token[]): string => {
  let out = "";
  for (const token of tokens) {
    out += renderInlineToken(asMarkedToken(token));
  }
  return out;
};

const renderBlockquote = (quote: Tokens.Blockquote): string =>
  renderBlockTokens(quote.tokens)
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

// Blocks inside a list item stack on single newlines (a blank separator
// would detach the lines from their marker); continuation lines are
// indented so nested lists and wrapped blocks read as part of the item.
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

const renderTable = (table: Tokens.Table): string => {
  const renderRow = (cells: Tokens.TableCell[]): string =>
    cells
      .map((cell) => renderInlineTokens(cell.tokens))
      .join(TABLE_CELL_SEPARATOR);
  const lines = [renderRow(table.header)];
  for (const row of table.rows) {
    lines.push(renderRow(row));
  }
  return lines.join("\n");
};

const renderBlockToken = (token: MarkedToken): string => {
  switch (token.type) {
    case "heading":
    case "paragraph":
      return renderInlineTokens(token.tokens);
    case "code":
      return token.text;
    case "blockquote":
      return renderBlockquote(token);
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

const renderBlockTokens = (tokens: Token[]): string => {
  const blocks: string[] = [];
  for (const token of tokens) {
    const rendered = renderBlockToken(asMarkedToken(token));
    if (rendered) {
      blocks.push(rendered);
    }
  }
  return blocks.join(BLOCK_SEPARATOR);
};

/**
 * Render standard markdown (CommonMark + GFM) to readable plain text:
 * emphasis markers stripped, links as `label (url)`, list bullets kept,
 * code verbatim. Used by the send pipeline to downgrade `markdown` content
 * on platforms without native support.
 */
export const markdownToPlainText = (markdown: string): string =>
  renderBlockTokens(markdownLexer.lexer(markdown)).trim();
