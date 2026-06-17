// Enrichment: the mention / edited / link-preview flags that ride alongside a
// message's text (and empty fallback) record so a bot can read them off it.

import type { ChatInboundMessage, ChatMessage } from "../types";

// Mention / edited / link-preview flags that ride alongside the text (and the
// empty fallback) record so a bot can read them off the message.
export type Enrichment = Pick<
  ChatInboundMessage,
  "isMention" | "edited" | "editedAt" | "links"
>;

export const buildEnrichment = (message: ChatMessage): Enrichment => ({
  ...(message.isMention ? { isMention: true } : {}),
  ...(message.metadata?.edited
    ? { edited: true, editedAt: message.metadata.editedAt }
    : {}),
  ...(message.links && message.links.length > 0
    ? { links: message.links }
    : {}),
});
