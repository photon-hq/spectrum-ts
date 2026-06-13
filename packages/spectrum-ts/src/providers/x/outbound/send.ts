import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import { UnsupportedError } from "../../../utils/errors";
import { X_PLATFORM, type XConfig } from "../config";
import { normalizeXConversationIdToInternal } from "../conversation-id";
import type { XSpace } from "../space";
import { sendDmByParticipantId } from "./client";

interface SendArgs {
  config: XConfig;
  content: Content;
  space: XSpace;
}

const resolveRecipientUserId = (
  spaceId: string,
  selfUserId: string
): string => {
  const normalized = normalizeXConversationIdToInternal(spaceId);
  const [left, right, ...rest] = normalized.split(":");
  if (rest.length === 0 && left && right) {
    if (left === selfUserId) {
      return right;
    }
    if (right === selfUserId) {
      return left;
    }
    throw new Error(
      `X conversation "${spaceId}" is not associated with xUserId "${selfUserId}"`
    );
  }
  return spaceId;
};

/**
 * Outbound dispatcher for v1 text DMs. Resolves the recipient from `space.id`
 * (raw user id or internal `a:b` conversation id) and sends via the X REST API.
 * Non-text content types throw `UnsupportedError`.
 */
export const send = async ({
  space,
  content,
  config,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  if (content.type !== "text") {
    throw UnsupportedError.content(content.type, X_PLATFORM);
  }

  const recipientUserId = resolveRecipientUserId(space.id, config.xUserId);
  const sent = await sendDmByParticipantId(config, recipientUserId, {
    text: content.text,
  });

  const now = new Date();
  return {
    id: sent.dmEventId,
    content,
    direction: "outbound",
    space: { id: normalizeXConversationIdToInternal(sent.dmConversationId) },
    timestamp: now,
  };
};
