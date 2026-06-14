import { asCustom } from "../../../content/custom";
import { asText } from "../../../content/text";
import type { FusorMessagesCtx } from "../../../fusor/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import type { XConfig } from "../config";
import { createCrcResponse } from "../crc";
import { resolveEffectiveConfig } from "../resolve-config";
import type { XPayload } from "../types";
import { parseWebhookPayload } from "./parser";

const toRecord = (event: ReturnType<typeof parseWebhookPayload>[number]) => {
  const text = event.text.trim();
  if (text.length === 0 && !event.encodedEvent) {
    return;
  }
  const content =
    text.length > 0 ? asText(text) : asCustom({ encodedEvent: event.encodedEvent });
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
 * echoes and messages from `xUserId`; empty text is ignored.
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
    const record = toRecord(event);
    if (record) {
      records.push(record);
    }
  }

  if (records.length === 0) {
    return;
  }
  return records.length === 1 ? records[0] : records;
};
