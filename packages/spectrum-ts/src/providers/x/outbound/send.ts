import type { Attachment } from "../../../content/attachment";
import type { Group } from "../../../content/group";
import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import { UnsupportedError } from "../../../utils/errors";
import type { Store } from "../../../utils/store";
import { X_PLATFORM, type XConfig, type XEffectiveConfig } from "../config";
import { normalizeXConversationIdToInternal } from "../conversation-id";
import { resolveEffectiveConfig } from "../resolve-config";
import type { XSpace } from "../space";
import { sendDmByParticipantId, type XCreateDmBody } from "./client";
import { uploadDmMedia } from "./media";

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

/** Send one DM body and shape the outbound record around the original content. */
const sendDm = async (
  effective: XEffectiveConfig,
  recipientUserId: string,
  body: XCreateDmBody,
  content: Content
): Promise<ProviderMessageRecord> => {
  const sent = await sendDmByParticipantId(
    { accessToken: effective.accessToken, baseUrl: effective.baseUrl },
    recipientUserId,
    body
  );
  return {
    id: sent.dmEventId,
    content,
    direction: "outbound",
    space: { id: normalizeXConversationIdToInternal(sent.dmConversationId) },
    timestamp: new Date(),
  };
};

/** Upload the attachment and build the DM body, attaching an optional caption. */
const buildMediaBody = async (
  effective: XEffectiveConfig,
  attachment: Attachment,
  text?: string
): Promise<XCreateDmBody> => {
  const mediaId = await uploadDmMedia(
    { accessToken: effective.accessToken, baseUrl: effective.baseUrl },
    attachment
  );
  return {
    attachments: [{ media_id: mediaId }],
    ...(text ? { text } : {}),
  };
};

// A Spectrum `group` maps to a single X DM only when it is one attachment with
// an optional text caption — X allows at most one media attachment per DM. Any
// other shape (multiple attachments/texts, other content types) is unsupported.
const resolveGroupCaption = (
  group: Group
): { attachment: Attachment; text?: string } => {
  let attachment: Attachment | undefined;
  let text: string | undefined;
  for (const item of group.items) {
    const inner = item.content;
    if (inner.type === "attachment") {
      if (attachment) {
        throw UnsupportedError.content(
          "group",
          X_PLATFORM,
          "a DM can carry only one media attachment."
        );
      }
      attachment = inner;
    } else if (inner.type === "text" && text === undefined) {
      text = inner.text;
    } else {
      throw UnsupportedError.content(
        "group",
        X_PLATFORM,
        "only a single attachment with an optional text caption is supported."
      );
    }
  }
  if (!attachment) {
    throw UnsupportedError.content(
      "group",
      X_PLATFORM,
      "a DM group must contain exactly one media attachment."
    );
  }
  return { attachment, text };
};

/**
 * Outbound dispatcher for X DMs. Supports `text`, a media `attachment`, and a
 * `group` of one attachment plus an optional text caption (sent as a single DM
 * carrying both text and media). All other content types throw
 * `UnsupportedError`. Media is uploaded via the chunked media endpoint and
 * attached by `media_id`.
 */
export const send = async ({
  space,
  content,
  config,
  store,
}: SendArgs): Promise<ProviderMessageRecord | undefined> => {
  if (
    content.type !== "text" &&
    content.type !== "attachment" &&
    content.type !== "group"
  ) {
    throw UnsupportedError.content(content.type, X_PLATFORM);
  }

  const effective = await resolveEffectiveConfig(config, store);
  const recipientUserId = resolveRecipientUserId(space.id, effective.xUserId);

  if (content.type === "text") {
    return await sendDm(
      effective,
      recipientUserId,
      { text: content.text },
      content
    );
  }

  let body: XCreateDmBody;
  if (content.type === "attachment") {
    body = await buildMediaBody(effective, content);
  } else {
    const { attachment, text } = resolveGroupCaption(content);
    body = await buildMediaBody(effective, attachment, text);
  }

  return await sendDm(effective, recipientUserId, body, content);
};
