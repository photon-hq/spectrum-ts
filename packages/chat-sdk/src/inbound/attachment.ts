// Attachment conversion: turn a chat-SDK attachment into Spectrum attachment
// (or voice) content, resolving the bytes lazily only when read.

import { asAttachment, asVoice } from "@spectrum-ts/core/authoring";
import type { ChatAttachment } from "../types";

const DEFAULT_MIME = "application/octet-stream";

// Resolve attachment bytes lazily: prefer the SDK's auth-aware `fetchData`,
// fall back to the URL, then to any already-fetched bytes.
const attachmentReader =
  (att: ChatAttachment): (() => Promise<Buffer>) =>
  async () => {
    if (att.fetchData) {
      return await att.fetchData();
    }
    if (att.url) {
      const res = await fetch(att.url);
      if (!res.ok) {
        throw new Error(
          `chat-sdk: fetching attachment "${att.name ?? "?"}" failed (${res.status} ${res.statusText})`
        );
      }
      return Buffer.from(await res.arrayBuffer());
    }
    const { data } = att;
    if (data) {
      if (data instanceof Buffer) {
        return data;
      }
      return Buffer.from(await (data as Blob).arrayBuffer());
    }
    throw new Error(
      `chat-sdk: attachment "${att.name ?? "?"}" has no fetchData, url, or data`
    );
  };

// Audio attachments surface as voice content; everything else as a file.
export const attachmentToContent = (att: ChatAttachment) => {
  const shared = {
    name: att.name ?? "attachment",
    mimeType: att.mimeType ?? DEFAULT_MIME,
    size: att.size,
    read: attachmentReader(att),
  };
  return att.type === "audio" ? asVoice(shared) : asAttachment(shared);
};
