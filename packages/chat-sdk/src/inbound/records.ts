// Record assembly: fan one inbound chat message out into Spectrum records —
// a text record, one per attachment, one per unfurled link, or a single custom
// "empty" record when none of those apply.

import { asCustom, asText } from "@spectrum-ts/core/authoring";
import type {
  ChatAdapter,
  ChatInboundMessage,
  ChatMessage,
  ChatThread,
} from "../types";
import { attachmentToContent } from "./attachment";
import { buildEnrichment, type Enrichment } from "./enrichment";
import { linkToContent } from "./link";
import { type RecordBase, spaceRef } from "./space";

// The text record keeps the bare message id when it stands alone, and gains a
// `:text` suffix once it shares the message with attachment/link records.
const textRecord = (
  message: ChatMessage,
  base: RecordBase,
  enrichment: Enrichment,
  hasSiblings: boolean
): ChatInboundMessage | undefined =>
  message.text
    ? {
        id: hasSiblings ? `${message.id}:text` : message.id,
        content: asText(message.text),
        ...base,
        ...enrichment,
      }
    : undefined;

// One record per attachment. A lone attachment (no text, no links) keeps the
// bare message id; otherwise each is suffixed `:file:<n>`.
const attachmentRecords = (
  message: ChatMessage,
  base: RecordBase,
  soleAttachment: boolean
): ChatInboundMessage[] =>
  (message.attachments ?? []).map((att, index) => ({
    id: soleAttachment ? message.id : `${message.id}:file:${index}`,
    content: attachmentToContent(att),
    ...base,
  }));

// One richlink record per unfurled link; links that fail to build are skipped
// (they still ride `enrichment.links`).
const linkRecords = (
  message: ChatMessage,
  base: RecordBase
): ChatInboundMessage[] =>
  (message.links ?? []).flatMap((link, index) => {
    const content = linkToContent(link);
    return content
      ? [{ id: `${message.id}:link:${index}`, content, ...base }]
      : [];
  });

// A message with no text, attachments, or links (sticker-only, embed-only,
// poll, system, …) still arrived — the host already filtered self / duplicate
// messages upstream (see `SpectrumChatHost.ingest`), so reaching here means it
// is genuinely empty. Surface it as custom content carrying the platform
// payload rather than dropping it, mirroring Slack's `slack_type: "empty"`.
const emptyRecord = (
  message: ChatMessage,
  base: RecordBase,
  enrichment: Enrichment
): ChatInboundMessage => ({
  id: message.id,
  content: asCustom({ chatsdk_type: "empty", raw: message.raw }),
  ...base,
  ...enrichment,
});

// One inbound chat message fans out to a text record, one record per attachment
// (mirrors the Slack provider's text/file split), and one richlink record per
// unfurled link — falling back to a single custom record when none apply.
export const messageToRecords = (
  adapter: ChatAdapter,
  threadId: string,
  message: ChatMessage,
  thread?: ChatThread
): ChatInboundMessage[] => {
  const base: RecordBase = {
    sender: { id: message.author.userId },
    space: spaceRef(adapter, threadId, thread),
    timestamp: message.metadata?.dateSent ?? new Date(),
  };
  const enrichment = buildEnrichment(message);
  const attachmentCount = message.attachments?.length ?? 0;
  const linkCount = message.links?.length ?? 0;
  const hasSiblings = attachmentCount > 0 || linkCount > 0;
  const soleAttachment =
    attachmentCount === 1 && linkCount === 0 && !message.text;

  const records = [
    textRecord(message, base, enrichment, hasSiblings),
    ...attachmentRecords(message, base, soleAttachment),
    ...linkRecords(message, base),
  ].filter((record): record is ChatInboundMessage => record !== undefined);

  return records.length > 0
    ? records
    : [emptyRecord(message, base, enrichment)];
};
