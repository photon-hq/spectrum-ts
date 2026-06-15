import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import { asAttachment } from "../../../content/attachment";
import { asCustom } from "../../../content/custom";
import { asGroup } from "../../../content/group";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import type { FusorMessagesCtx } from "../../../fusor/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { Message as SpectrumMessage } from "../../../types/message";
import { fetchUrlBytes } from "../../../utils/io";
import type { XConfig } from "../config";
import { createCrcResponse } from "../crc";
import { resolveEffectiveConfig } from "../resolve-config";
import type { XPayload } from "../types";
import { type ParsedWebhookEvent, parseWebhookPayload } from "./parser";

// Inbound items are not full Messages yet — core's wrapProviderMessage inflates
// them. A minimal `{ id, content }` shape satisfies the `isMessage` guard used
// for group items.
const stubMessage = (id: string, content: Content): SpectrumMessage =>
  ({ id, content }) as unknown as SpectrumMessage;

const mimeForMediaType = (type: string | undefined): string => {
  if (type === "video") {
    return "video/mp4";
  }
  if (type === "animated_gif") {
    return "image/gif";
  }
  return "image/jpeg";
};

/**
 * Build a lazily-downloaded attachment from a DM media URL. The bytes are only
 * fetched (with the user's bearer token) when the consumer calls `read()`,
 * keeping the webhook ack path free of network I/O.
 */
const buildMediaAttachment = (
  event: ParsedWebhookEvent,
  accessToken: string
): Content => {
  const url = new URL(event.mediaUrl as string);
  const name = basename(url.pathname) || (event.mediaId ?? "media");
  const mimeType = lookupMimeType(name) || mimeForMediaType(event.mediaType);
  return asAttachment({
    id: event.mediaId ?? name,
    name,
    mimeType,
    read: async () =>
      (
        await fetchUrlBytes(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      ).data,
  });
};

/**
 * Resolve an inbound event to its Spectrum content: media + text caption become
 * a `group` ([caption, media]), media-only becomes a bare attachment, otherwise
 * text or the raw encoded event. Returns `undefined` when nothing is
 * representable so the caller can drop it.
 */
const resolveContent = (
  event: ParsedWebhookEvent,
  accessToken: string
): Content | undefined => {
  const text = event.text.trim();
  if (event.mediaUrl) {
    const media = buildMediaAttachment(event, accessToken);
    if (text.length > 0) {
      return asGroup({
        items: [
          stubMessage(`${event.eventId}:0`, asText(text)),
          stubMessage(`${event.eventId}:1`, media),
        ],
      });
    }
    return media;
  }
  if (text.length > 0) {
    return asText(text);
  }
  if (event.encodedEvent) {
    return asCustom({ encodedEvent: event.encodedEvent });
  }
  return;
};

const toRecord = (
  event: ParsedWebhookEvent,
  accessToken: string
): ProviderMessageRecord | undefined => {
  const content = resolveContent(event, accessToken);
  if (!content) {
    return;
  }
  const senderHandle = event.sender.username;
  return {
    id: event.eventId,
    content,
    direction: "inbound",
    sender: {
      id: event.sender.id,
      ...(senderHandle ? { handle: senderHandle } : {}),
    },
    space: { id: event.conversationId },
    ...(event.createdAt ? { timestamp: event.createdAt } : {}),
  } satisfies ProviderMessageRecord;
};

/**
 * Map a verified X payload to Spectrum message records. CRC challenges are
 * answered via `respond` and return `undefined`. Inbound DMs skip outbound
 * echoes and messages from `xUserId`; empty text with no media is ignored.
 */
export const handleMessages = async ({
  payload,
  respond,
  config,
  store,
}: FusorMessagesCtx<XPayload, XConfig>): Promise<
  ProviderMessageRecord | ProviderMessageRecord[] | undefined
> => {
  const effective = await resolveEffectiveConfig(config, store);

  console.log("payload", JSON.stringify(payload, null, 2));
  /**
   * We must handle CRC challenges to register the webhook with X API. Furthermore
   * X will repeatedly send CRC challenges every 30 minutes to ensure the webhook
   *  is still active and secured.
   */


  if (payload.type === "crc") {
    const crcResponse = createCrcResponse(
      payload.crcToken,
      effective.consumerSecret
    );
    respond({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(crcResponse),
    });

    return;
  }

  const records: ProviderMessageRecord[] = [];
  for (const event of parseWebhookPayload(payload.body)) {
    if (
      event.direction === "outbound" ||
      event.sender.id === effective.xUserId
    ) {
      continue;
    }
    const record = toRecord(event, effective.accessToken);
    if (record) {
      records.push(record);
    }
  }

  if (records.length === 0) {
    return;
  }
  return records.length === 1 ? records[0] : records;
};
