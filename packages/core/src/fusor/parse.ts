export interface ParsedHttpRequest {
  headers: Record<string, string>;
  method: string;
  path: string;
  rawBody: Uint8Array;
}

const CR = 0x0d;
const LF = 0x0a;

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === CR &&
      bytes[i + 1] === LF &&
      bytes[i + 2] === CR &&
      bytes[i + 3] === LF
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Parses an HTTP/1.1 wire-format request out of `raw_request` from
 * `RawInboundEvent`. Headers are lowercased. Multiple header values with the
 * same name are joined with ", " (RFC 7230 §3.2.2).
 */
export function parseHttpRequest(bytes: Uint8Array): ParsedHttpRequest {
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd < 0) {
    throw new Error("fusor: raw_request missing CRLFCRLF header terminator");
  }
  const headerText = new TextDecoder("utf-8").decode(
    bytes.subarray(0, headerEnd)
  );
  const rawBody = bytes.subarray(headerEnd + 4);

  const lines = headerText.split("\r\n");
  const requestLine = lines[0];
  if (!requestLine) {
    throw new Error("fusor: raw_request missing request line");
  }

  const firstSpace = requestLine.indexOf(" ");
  const lastSpace = requestLine.lastIndexOf(" ");
  if (firstSpace < 0 || lastSpace <= firstSpace) {
    throw new Error(`fusor: malformed request line: ${requestLine}`);
  }
  const method = requestLine.slice(0, firstSpace);
  const path = requestLine.slice(firstSpace + 1, lastSpace);

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!key) {
      continue;
    }
    const existing = headers[key];
    headers[key] = existing ? `${existing}, ${value}` : value;
  }

  return { method, path, headers, rawBody };
}
