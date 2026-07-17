import {
  type AdvancedIMessage,
  type ChatServiceType,
  type MessageEvent,
  NotFoundError,
  type SingleServiceAddressInfo,
} from "@photon-ai/advanced-imessage";
import { type Content, fromVCard, type Group } from "@spectrum-ts/core";
import {
  asAttachment,
  asContact,
  asCustom,
  asReply,
  asText,
  asVoice,
  createLogger,
  errorAttrs,
  groupSchema,
  type ProviderMessageRecord,
} from "@spectrum-ts/core/authoring";
import { getMessageCache, type MessageCache } from "../cache";
import {
  appleAudioMimeType,
  normalizeAppleAttachmentMimeType,
} from "../shared/audio";
import { type OrderedPart, toOrderedParts } from "../shared/inbound-parts";
import { isVCardAttachment } from "../shared/vcard";
import type { IMessageMessage } from "../types";
import {
  downloadPrimaryAttachment,
  downloadPrimaryAttachmentStream,
} from "./attachments";
import {
  chatTypeFromGuid,
  formatChildId,
  parseChildId,
  toMessageGuid,
} from "./ids";

const log = createLogger("spectrum.imessage.inbound");

export type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;
export type AppleMessage = ReceivedEvent["message"];
type AppleAttachment = AppleMessage["content"]["attachments"][number];
export type RemoteMessageBase = Omit<IMessageMessage, "id" | "content">;

const messageAttachments = (
  message: AppleMessage
): readonly AppleAttachment[] => message.content.attachments;

const resolveChatGuid = (
  message: AppleMessage,
  hint: string | undefined
): string => {
  if (hint) {
    return hint;
  }
  const first = message.chatGuids?.[0];
  return first ?? "";
};

/**
 * Normalize an Apple address (`message.sender` or an event `actor`) into the
 * spectrum sender ref. `id` stays the cross-provider identity key (the
 * address); `address`/`country`/`service` are surfaced when present so apps
 * can tell iMessage from SMS/RCS. Empty fields are omitted.
 */
export const toSenderRef = (
  addr: SingleServiceAddressInfo | undefined
): {
  id: string;
  address?: string;
  country?: string;
  service?: ChatServiceType;
} => ({
  id: addr?.address ?? "",
  ...(addr?.address ? { address: addr.address } : {}),
  ...(addr?.country ? { country: addr.country } : {}),
  ...(addr?.service ? { service: addr.service } : {}),
});

type RawProviderMessage = Pick<IMessageMessage, "content" | "id">;
interface BuildContentOptions {
  cache?: MessageCache;
  phone: string;
  visitedReplyGuids?: ReadonlySet<string>;
}

export const isIMessageMessage = (value: unknown): value is IMessageMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.content === "object" &&
    record.content !== null &&
    typeof record.space === "object" &&
    record.space !== null
  );
};

const asProviderGroup = (items: readonly RawProviderMessage[]): Group =>
  groupSchema.parse({ type: "group", items });

const asProviderReply = (
  content: Content,
  target: RawProviderMessage
): Content =>
  asReply({
    content: content as Parameters<typeof asReply>[0]["content"],
    target: target as unknown as Parameters<typeof asReply>[0]["target"],
  });

export const buildMessageBase = (
  message: AppleMessage,
  chatGuidHint: string | undefined,
  timestamp: Date,
  phone: string
): RemoteMessageBase => {
  const chat = resolveChatGuid(message, chatGuidHint);
  return {
    direction: message.isFromMe ? "outbound" : "inbound",
    sender: toSenderRef(message.sender),
    space: {
      id: chat,
      type: chatTypeFromGuid(chat),
      phone,
    },
    timestamp,
  };
};

const toAttachmentContent = (
  client: AdvancedIMessage,
  info: AppleAttachment
): Content =>
  asAttachment({
    id: info.guid,
    name: info.fileName,
    mimeType: normalizeAppleAttachmentMimeType(info),
    size: info.totalBytes,
    read: async () => await downloadPrimaryAttachment(client, info.guid),
    stream: async () => downloadPrimaryAttachmentStream(client, info.guid),
  });

const toVoiceContent = (
  client: AdvancedIMessage,
  info: AppleAttachment,
  mimeType: string
): Content =>
  asVoice({
    id: info.guid,
    name: info.fileName,
    mimeType,
    size: info.totalBytes,
    read: async () => await downloadPrimaryAttachment(client, info.guid),
    stream: async () => downloadPrimaryAttachmentStream(client, info.guid),
  });

const toVCardContent = async (
  client: AdvancedIMessage,
  info: AppleAttachment
): Promise<Content> => {
  try {
    const buf = await downloadPrimaryAttachment(client, info.guid);
    return asContact(fromVCard(buf.toString("utf8")));
  } catch (err) {
    log.warn(
      "failed to parse vCard attachment; falling back to attachment content",
      { "spectrum.imessage.attachment.guid": info.guid, ...errorAttrs(err) },
      err
    );
    return toAttachmentContent(client, info);
  }
};

const attachmentContent = async (
  client: AdvancedIMessage,
  info: AppleAttachment,
  isVoice: boolean
): Promise<Content> => {
  if (isVCardAttachment(info.mimeType, info.fileName)) {
    return await toVCardContent(client, info);
  }
  const audioMimeType = isVoice ? appleAudioMimeType(info) : undefined;
  return audioMimeType
    ? toVoiceContent(client, info, audioMimeType)
    : toAttachmentContent(client, info);
};

const buildAttachmentMessage = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  info: AppleAttachment,
  id: string,
  partIndex: number,
  parentId?: string,
  isVoice = false
): Promise<IMessageMessage> => {
  const content = await attachmentContent(client, info, isVoice);
  const msg: IMessageMessage = { ...base, id, content, partIndex };
  if (parentId !== undefined) {
    msg.parentId = parentId;
  }
  return msg;
};

const buildTextMessage = (
  base: RemoteMessageBase,
  text: string,
  id: string,
  partIndex: number,
  parentId?: string
): IMessageMessage => {
  const msg: IMessageMessage = {
    ...base,
    id,
    content: asText(text),
    partIndex,
  };
  if (parentId !== undefined) {
    msg.parentId = parentId;
  }
  return msg;
};

const buildOrderedPartMessage = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  part: OrderedPart<AppleAttachment>,
  id: string,
  partIndex: number,
  parentId?: string,
  voiceAttachmentGuid?: string
): Promise<IMessageMessage> =>
  part.type === "text"
    ? buildTextMessage(base, part.text, id, partIndex, parentId)
    : await buildAttachmentMessage(
        client,
        base,
        part.attachment,
        id,
        partIndex,
        parentId,
        part.attachment.guid === voiceAttachmentGuid
      );

const buildUnwrappedContentMessage = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  message: AppleMessage,
  messageGuidStr: string
): Promise<IMessageMessage> => {
  const attachments = messageAttachments(message);
  const voiceAttachmentGuid = message.isAudioMessage
    ? attachments.find((attachment) => appleAudioMimeType(attachment))?.guid
    : undefined;

  if (attachments.length === 0) {
    const text = message.content.text;
    return {
      ...base,
      id: messageGuidStr,
      content: text ? asText(text) : asCustom(message),
    };
  }

  const parts = toOrderedParts(message.content.text, attachments);

  if (parts.length === 0) {
    return {
      ...base,
      id: messageGuidStr,
      content: asCustom(message),
    };
  }

  if (parts.length === 1) {
    const part = parts[0];
    if (!part) {
      throw new Error("Unreachable: parts.length === 1 but no element");
    }
    return buildOrderedPartMessage(
      client,
      base,
      part,
      messageGuidStr,
      0,
      undefined,
      voiceAttachmentGuid
    );
  }

  const items: IMessageMessage[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    items.push(
      await buildOrderedPartMessage(
        client,
        base,
        part,
        formatChildId(i, messageGuidStr),
        i,
        messageGuidStr,
        voiceAttachmentGuid
      )
    );
  }

  return {
    ...base,
    id: messageGuidStr,
    content: asProviderGroup(items),
  };
};

const replyTargetGuid = (message: AppleMessage): string | undefined =>
  message.replyTargetGuid ?? message.threadOriginatorGuid;

const stubReplyTarget = (
  base: RemoteMessageBase,
  targetGuid: string
): ProviderMessageRecord => ({
  id: targetGuid,
  content: asCustom({ imessage_type: "reply-target", stub: true }),
  space: base.space,
});

const resolveReplyTarget = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  targetGuid: string,
  currentGuid: string,
  options: BuildContentOptions
): Promise<RawProviderMessage> => {
  if (
    targetGuid === currentGuid ||
    options.visitedReplyGuids?.has(targetGuid)
  ) {
    return stubReplyTarget(base, targetGuid);
  }

  const cached = options.cache?.get(targetGuid);
  if (cached) {
    return cached;
  }

  try {
    const visitedReplyGuids = new Set(options.visitedReplyGuids);
    visitedReplyGuids.add(currentGuid);
    const fetched = await client.messages.get(toMessageGuid(targetGuid));
    const rebuilt = await rebuildFromAppleMessage(
      client,
      fetched,
      options.phone,
      base.space.id,
      options.cache,
      visitedReplyGuids
    );
    if (options.cache) {
      cacheMessage(options.cache, rebuilt);
    }
    return rebuilt;
  } catch (err) {
    if (!(err instanceof NotFoundError)) {
      log.warn(
        "failed to resolve iMessage reply target; falling back to stub target",
        {
          "spectrum.imessage.message.guid": currentGuid,
          "spectrum.imessage.reply.target_guid": targetGuid,
          ...errorAttrs(err),
        },
        err
      );
    }
    return stubReplyTarget(base, targetGuid);
  }
};

const buildContentMessage = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  message: AppleMessage,
  messageGuidStr: string,
  options: BuildContentOptions
): Promise<IMessageMessage> => {
  const msg = await buildUnwrappedContentMessage(
    client,
    base,
    message,
    messageGuidStr
  );
  const targetGuid = replyTargetGuid(message);
  if (!targetGuid) {
    return msg;
  }
  const target = await resolveReplyTarget(
    client,
    base,
    targetGuid,
    messageGuidStr,
    options
  );
  return {
    ...msg,
    content: asProviderReply(msg.content, target),
  };
};

const messageGroupContent = (message: IMessageMessage): Group | undefined => {
  if (message.content.type === "group") {
    return message.content;
  }
  if (
    message.content.type === "reply" &&
    message.content.content.type === "group"
  ) {
    return message.content.content;
  }
  return;
};

export const rebuildFromAppleMessage = async (
  client: AdvancedIMessage,
  message: AppleMessage,
  phone: string,
  chatGuidHint?: string,
  cache?: MessageCache,
  visitedReplyGuids?: ReadonlySet<string>
): Promise<IMessageMessage> => {
  const messageGuidStr = message.guid as string;
  const timestamp = message.dateCreated ?? new Date();
  const base = buildMessageBase(message, chatGuidHint, timestamp, phone);
  return buildContentMessage(client, base, message, messageGuidStr, {
    cache,
    phone,
    visitedReplyGuids,
  });
};

export const cacheMessage = (
  cache: MessageCache,
  message: IMessageMessage
): void => {
  cache.set(message.id, message);
  const group = messageGroupContent(message);
  if (group) {
    for (const item of group.items) {
      if (isIMessageMessage(item)) {
        cache.set(item.id, item);
      }
    }
  }
};

export const toInboundMessages = async (
  client: AdvancedIMessage,
  cache: MessageCache,
  event: ReceivedEvent,
  phone: string
): Promise<IMessageMessage[]> => {
  const base = buildMessageBase(
    event.message,
    event.chatGuid,
    event.occurredAt,
    phone
  );
  const messageGuidStr = event.message.guid as string;
  const msg = await buildContentMessage(
    client,
    base,
    event.message,
    messageGuidStr,
    { cache, phone }
  );
  cacheMessage(cache, msg);
  return [msg];
};

export const getMessage = async (
  remote: AdvancedIMessage,
  spaceId: string,
  msgId: string,
  phone: string
): Promise<IMessageMessage | undefined> => {
  const cache = getMessageCache(remote);
  const cached = cache.get(msgId);
  if (cached) {
    return cached;
  }

  const childRef = parseChildId(msgId);
  if (childRef) {
    try {
      const fetched = await remote.messages.get(
        toMessageGuid(childRef.parentGuid)
      );
      const parent = await rebuildFromAppleMessage(
        remote,
        fetched,
        phone,
        spaceId,
        cache
      );
      cacheMessage(cache, parent);
      const group = messageGroupContent(parent);
      if (!group) {
        return;
      }
      const item = group.items[childRef.partIndex];
      return isIMessageMessage(item) ? item : undefined;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return;
      }
      throw err;
    }
  }

  try {
    const fetched = await remote.messages.get(toMessageGuid(msgId));
    const rebuilt = await rebuildFromAppleMessage(
      remote,
      fetched,
      phone,
      spaceId,
      cache
    );
    cacheMessage(cache, rebuilt);
    return rebuilt;
  } catch (err) {
    if (err instanceof NotFoundError) {
      return;
    }
    throw err;
  }
};
