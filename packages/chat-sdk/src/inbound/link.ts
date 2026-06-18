// Link conversion: turn a link the SDK already unfurled into richlink content,
// reusing its metadata so no network fetch happens.

import { asRichlink } from "@spectrum-ts/core/authoring";
import type { ChatLinkPreview } from "../types";

// The SDK already unfurled the link, so build the richlink from its metadata
// without a network fetch. A malformed URL would otherwise throw and drop the
// whole message — return undefined so the caller skips it (it still rides
// `enrichment.links`).
export const linkToContent = (link: ChatLinkPreview) => {
  try {
    return asRichlink({
      url: link.url,
      title: link.title,
      summary: link.description,
      cover: link.imageUrl ? { imageUrl: link.imageUrl } : undefined,
    });
  } catch {
    return;
  }
};
