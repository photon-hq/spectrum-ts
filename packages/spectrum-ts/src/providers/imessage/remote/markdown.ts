import type { TextFormatInput } from "@photon-ai/advanced-imessage";
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

const LEADING_WHITESPACE = /^\s+/;
const TRAILING_WHITESPACE = /\s+$/;

// Unicode mathematical monospace alphanumerics (U+1D670–U+1D6A3 letters,
// U+1D7F6–U+1D7FF digits). iMessage formatting has no monospace attribute,
// so code renders through these characters instead — `npm` → 𝚗𝚙𝚖. Anything
// outside ASCII alphanumerics (punctuation, spaces, non-ASCII) passes
// through unchanged.
const MONOSPACE_UPPER_A = 0x1_d6_70;
const MONOSPACE_LOWER_A = 0x1_d6_8a;
const MONOSPACE_DIGIT_ZERO = 0x1_d7_f6;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

const monospaceCodePoint = (codePoint: number): number => {
  if (codePoint >= UPPER_A && codePoint <= UPPER_Z) {
    return MONOSPACE_UPPER_A + (codePoint - UPPER_A);
  }
  if (codePoint >= LOWER_A && codePoint <= LOWER_Z) {
    return MONOSPACE_LOWER_A + (codePoint - LOWER_A);
  }
  if (codePoint >= DIGIT_ZERO && codePoint <= DIGIT_NINE) {
    return MONOSPACE_DIGIT_ZERO + (codePoint - DIGIT_ZERO);
  }
  return codePoint;
};

// Monospace characters are astral (2 UTF-16 units each); offsets stay
// correct because `finalize` measures the converted text, not the source.
const toMonospace = (text: string): string => {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    out +=
      codePoint === undefined
        ? char
        : String.fromCodePoint(monospaceCodePoint(codePoint));
  }
  return out;
};

// The subset of `TextFormatInput` types markdown emphasis maps onto.
// Markdown has no underline syntax, and per-character animation effects have
// no markdown equivalent, so neither is ever emitted.
type InlineStyle = "bold" | "italic" | "strikethrough";

const STYLE_ORDER: readonly InlineStyle[] = ["bold", "italic", "strikethrough"];

// One run of text whose characters all share the same style set. Block
// constructs inject unstyled prefix/separator spans between styled runs, so
// a formatting range can never leak onto a list marker, a `> ` prefix, or a
// block separator. Offsets are assigned only in `finalize`, after the full
// span sequence (including trim) is fixed — they can never be invalidated.
interface StyledSpan {
  /** Set on spans produced by link/image rendering — drives `hasLinks`. */
  readonly link?: boolean;
  readonly styles: readonly InlineStyle[];
  readonly text: string;
}

export interface IMessageRenderedMarkdown {
  readonly formatting: readonly TextFormatInput[];
  readonly hasLinks: boolean;
  readonly text: string;
}

const plain = (text: string): StyledSpan => ({ text, styles: [] });

const withStyle = (spans: StyledSpan[], style: InlineStyle): StyledSpan[] =>
  spans.map((span) =>
    span.styles.includes(style)
      ? span
      : { ...span, styles: [...span.styles, style] }
  );

const asLink = (spans: StyledSpan[]): StyledSpan[] =>
  spans.map((span) => ({ ...span, link: true }));

const spanText = (spans: readonly StyledSpan[]): string => {
  let out = "";
  for (const span of spans) {
    out += span.text;
  }
  return out;
};

// Interleave an unstyled separator between blocks. Separators only ever sit
// *between* blocks — never leading or trailing — mirroring how the sibling
// renderers `blocks.join(...)`.
const joinSpans = (blocks: StyledSpan[][], separator: string): StyledSpan[] => {
  const out: StyledSpan[] = [];
  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      out.push(plain(separator));
    }
    out.push(...block);
  }
  return out;
};

// Split a span run into lines at `"\n"` so list items and blockquotes can
// inject unstyled per-line prefixes. A newline inside a styled span (a `br`
// under `strong`) becomes a line boundary; the rejoining newline is emitted
// unstyled by the caller.
const splitSpanLines = (spans: readonly StyledSpan[]): StyledSpan[][] => {
  let current: StyledSpan[] = [];
  const lines: StyledSpan[][] = [current];
  for (const span of spans) {
    const parts = span.text.split("\n");
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        current = [];
        lines.push(current);
      }
      if (part) {
        current.push({ ...span, text: part });
      }
    }
  }
  return lines;
};

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

const renderLink = (token: Tokens.Link): StyledSpan[] => {
  // A bare autolink lexes with its label equal to its href — render the
  // url alone instead of doubling it as "url (url)".
  if (token.text === token.href) {
    return [{ text: token.href, styles: [], link: true }];
  }
  // The label keeps its inline styling; the " (url)" suffix stays unstyled.
  return [
    ...asLink(renderInlineTokens(token.tokens)),
    { text: ` (${token.href})`, styles: [], link: true },
  ];
};

const renderImage = (token: Tokens.Image): StyledSpan[] => [
  {
    text: token.text ? `${token.text} (${token.href})` : token.href,
    styles: [],
    link: true,
  },
];

const renderInlineToken = (token: MarkedToken): StyledSpan[] => {
  switch (token.type) {
    case "strong":
      return withStyle(renderInlineTokens(token.tokens), "bold");
    case "em":
      return withStyle(renderInlineTokens(token.tokens), "italic");
    case "del":
      return withStyle(renderInlineTokens(token.tokens), "strikethrough");
    case "codespan":
      return [plain(toMonospace(token.text))];
    case "br":
      return [plain("\n")];
    case "link":
      return renderLink(token);
    case "image":
      return renderImage(token);
    case "escape":
      return [plain(token.text)];
    case "text":
      return token.tokens
        ? renderInlineTokens(token.tokens)
        : [plain(token.text)];
    // Raw HTML in markdown source stays literal — styled text has no markup.
    case "html":
      return [plain(token.text)];
    // Task-item checkboxes are rendered from `ListItem.task`/`checked`.
    case "checkbox":
      return [];
    default:
      return "raw" in token ? [plain(String(token.raw))] : [];
  }
};

const renderInlineTokens = (tokens: Token[]): StyledSpan[] => {
  const out: StyledSpan[] = [];
  for (const token of tokens) {
    out.push(...renderInlineToken(asMarkedToken(token)));
  }
  return out;
};

const renderBlockquote = (quote: Tokens.Blockquote): StyledSpan[] => {
  const lines = splitSpanLines(renderBlockTokens(quote.tokens));
  const out: StyledSpan[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      out.push(plain("\n"));
    }
    out.push(plain(line.length > 0 ? "> " : ">"), ...line);
  }
  return out;
};

// Blocks inside a list item stack on single newlines (a blank separator
// would detach the lines from their marker); continuation lines are
// indented so nested lists and wrapped blocks read as part of the item.
const renderList = (list: Tokens.List): StyledSpan[] => {
  const out: StyledSpan[] = [];
  for (const [index, item] of list.items.entries()) {
    const prefix = `${listMarker(list, index)}${checkboxPrefix(item)}`;
    const blocks: StyledSpan[][] = [];
    for (const token of item.tokens) {
      const rendered = renderBlockToken(asMarkedToken(token));
      if (spanText(rendered)) {
        blocks.push(rendered);
      }
    }
    const [first = [], ...rest] = splitSpanLines(joinSpans(blocks, "\n"));
    if (out.length > 0) {
      out.push(plain("\n"));
    }
    out.push(plain(prefix), ...first);
    for (const line of rest) {
      out.push(plain(`\n${NESTED_LIST_INDENT}`), ...line);
    }
  }
  return out;
};

// Same row layout as the plain-text renderer ("h1 | h2" lines). Unlike
// Telegram's <pre> fallback nothing here forces cells to drop their inline
// styling, so emphasis ranges flow through.
const renderTable = (table: Tokens.Table): StyledSpan[] => {
  const out: StyledSpan[] = [];
  const pushRow = (cells: Tokens.TableCell[], rowIndex: number): void => {
    if (rowIndex > 0) {
      out.push(plain("\n"));
    }
    for (const [cellIndex, cell] of cells.entries()) {
      if (cellIndex > 0) {
        out.push(plain(TABLE_CELL_SEPARATOR));
      }
      out.push(...renderInlineTokens(cell.tokens));
    }
  };
  pushRow(table.header, 0);
  for (const [index, row] of table.rows.entries()) {
    pushRow(row, index + 1);
  }
  return out;
};

const renderBlockToken = (token: MarkedToken): StyledSpan[] => {
  switch (token.type) {
    // iMessage formatting has no heading sizes; bold is the conventional
    // stand-in (Telegram precedent).
    case "heading":
      return withStyle(renderInlineTokens(token.tokens), "bold");
    case "paragraph":
      return renderInlineTokens(token.tokens);
    case "code":
      return [plain(toMonospace(token.text))];
    case "blockquote":
      return renderBlockquote(token);
    case "list":
      return renderList(token);
    case "table":
      return renderTable(token);
    case "hr":
      return [plain(HR_LINE)];
    case "space":
    case "def":
      return [];
    default:
      return renderInlineToken(token);
  }
};

const renderBlockTokens = (tokens: Token[]): StyledSpan[] => {
  const blocks: StyledSpan[][] = [];
  for (const token of tokens) {
    const rendered = renderBlockToken(asMarkedToken(token));
    if (spanText(rendered)) {
      blocks.push(rendered);
    }
  }
  return joinSpans(blocks, BLOCK_SEPARATOR);
};

// Strip leading/trailing whitespace at the span level, before offsets are
// assigned — trimming the final string instead would invalidate every range
// start (the sibling renderers' closing `.trim()` has no such concern).
const trimSpans = (spans: StyledSpan[]): StyledSpan[] => {
  const trimmed = [...spans];
  while (trimmed.length > 0) {
    const first = trimmed.at(0);
    const text = first?.text.replace(LEADING_WHITESPACE, "");
    if (first && text) {
      trimmed[0] = { ...first, text };
      break;
    }
    trimmed.shift();
  }
  while (trimmed.length > 0) {
    const last = trimmed.at(-1);
    const text = last?.text.replace(TRAILING_WHITESPACE, "");
    if (last && text) {
      trimmed[trimmed.length - 1] = { ...last, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
};

// Single offset-assigning pass. JS string lengths are UTF-16 code units —
// exactly the unit `TextFormatInput` ranges use — so plain concatenation
// counts correctly (an emoji surrogate pair is 2 units). Adjacent spans
// sharing a style keep one range open (coalescing); a span missing the style
// closes it. Unstyled separator/prefix spans therefore bound every range.
const finalize = (spans: StyledSpan[]): IMessageRenderedMarkdown => {
  let text = "";
  let hasLinks = false;
  const open = new Map<InlineStyle, number>();
  const ranges: { type: InlineStyle; start: number; length: number }[] = [];

  const close = (style: InlineStyle, end: number): void => {
    const start = open.get(style);
    open.delete(style);
    if (start !== undefined && end > start) {
      ranges.push({ type: style, start, length: end - start });
    }
  };

  for (const span of spans) {
    if (!span.text) {
      continue;
    }
    hasLinks ||= span.link === true;
    const offset = text.length;
    for (const style of STYLE_ORDER) {
      if (span.styles.includes(style)) {
        if (!open.has(style)) {
          open.set(style, offset);
        }
      } else {
        close(style, offset);
      }
    }
    text += span.text;
  }
  for (const style of STYLE_ORDER) {
    close(style, text.length);
  }

  ranges.sort(
    (a, b) =>
      a.start - b.start ||
      STYLE_ORDER.indexOf(a.type) - STYLE_ORDER.indexOf(b.type)
  );
  return { text, formatting: ranges, hasLinks };
};

/**
 * Render standard markdown (CommonMark + GFM) to iMessage styled text: a
 * plain string plus UTF-16 formatting ranges for `messages.sendText`'s
 * `formatting` option. Block layout matches the plain-text renderer (list
 * bullets, `label (url)` links); inline emphasis becomes native
 * bold/italic/strikethrough ranges instead of being stripped, headings
 * render as bold, and code maps to Unicode mathematical monospace
 * characters. `hasLinks` reports whether any link or image put a URL into
 * the text, so the sender can enable Apple's data-detector pass.
 */
export const markdownToIMessageText = (
  markdown: string
): IMessageRenderedMarkdown =>
  finalize(trimSpans(renderBlockTokens(markdownLexer.lexer(markdown))));
