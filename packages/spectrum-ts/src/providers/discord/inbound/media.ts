import { asAttachment } from "../../../content/attachment";
import type { Content } from "../../../content/types";
import type { DiscordAttachment } from "../types";
import { downloadAttachment } from "../util";

const DEFAULT_ATTACHMENT_MIME = "application/octet-stream";

/**
 * Map a Discord message attachment to its Spectrum `Content`. Discord already
 * gives a direct CDN `url`, filename, size and (usually) content type, so —
 * unlike Telegram's two-step `getFile` — bytes are read lazily with a single
 * authenticated-free `fetch` of that url only when the consumer calls `read()`.
 * The `as*` builders memoize `read`, so a file downloads once.
 */
export const attachmentToContent = (file: DiscordAttachment): Content =>
  asAttachment({
    id: file.id,
    name: file.filename,
    mimeType: file.content_type ?? DEFAULT_ATTACHMENT_MIME,
    size: file.size,
    read: () => downloadAttachment(file.url),
  });
