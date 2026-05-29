import type { Content } from "spectrum-ts";
import {
  asAttachment,
  asRichlink,
  asText,
  asVoice,
} from "spectrum-ts/authoring";
import { fetchBytes } from "../http";
import type { LinqInboundPart } from "../types";

const AUDIO_MIME_PATTERN = /^audio\//i;

/**
 * Map one inbound LinQ message part to Spectrum `Content`.
 *
 * - `text` → `text`
 * - `link` → `richlink` (LinQ link parts are rich previews)
 * - `media` → `voice` for `audio/*`, else `attachment`. Bytes are read lazily
 *   from the presigned `url` (no auth needed) only when the consumer calls
 *   `content.read()`.
 */
export const partToContent = (part: LinqInboundPart): Content => {
  if (part.type === "text") {
    return asText(part.value);
  }
  if (part.type === "link") {
    return asRichlink({ url: part.value });
  }
  const read = () => fetchBytes(part.url);
  if (AUDIO_MIME_PATTERN.test(part.mime_type)) {
    return asVoice({
      name: part.filename,
      mimeType: part.mime_type,
      size: part.size_bytes,
      read,
    });
  }
  return asAttachment({
    id: part.id,
    name: part.filename,
    mimeType: part.mime_type,
    size: part.size_bytes,
    read,
  });
};
