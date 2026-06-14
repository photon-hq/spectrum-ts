import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import { UnsupportedError } from "../../../utils/errors";
import type { Store } from "../../../utils/store";
import { X_PLATFORM, type XConfig } from "../config";
import { normalizeXConversationIdToInternal } from "../conversation-id";
import { resolveEffectiveConfig } from "../resolve-config";
import type { XSpace } from "../space";
import { sendDmByParticipantId } from "./client";

interface SendArgs {
  config: XConfig;
  content: Content;
  space: XSpace;
  store: Store;
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
  store,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  if (content.type !== "text") {
    throw UnsupportedError.content(content.type, X_PLATFORM);
  }

  const effective = await resolveEffectiveConfig(config, store);
  const recipientUserId = resolveRecipientUserId(space.id, effective.xUserId);
  const sent = await sendDmByParticipantId(
    {
      accessToken: effective.accessToken,
      baseUrl: effective.baseUrl,
    },
    recipientUserId,
    { text: content.text }
  );

  const now = new Date();
  return {
    id: sent.dmEventId,
    content,
    direction: "outbound",
    space: { id: normalizeXConversationIdToInternal(sent.dmConversationId) },
    timestamp: now,
  };
};
