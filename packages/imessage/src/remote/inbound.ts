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
  asText,
  createLogger,
  errorAttrs,
  groupSchema,
} from "@spectrum-ts/core/authoring";
import { getMessageCache, type MessageCache } from "../cache";
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
    mimeType: info.mimeType,
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
  info: AppleAttachment
): Promise<Content> =>
  isVCardAttachment(info.mimeType, info.fileName)
    ? await toVCardContent(client, info)
    : toAttachmentContent(client, info);

const buildAttachmentMessage = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  info: AppleAttachment,
  id: string,
  partIndex: number,
  parentId?: string
): Promise<IMessageMessage> => {
  const content = await attachmentContent(client, info);
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
  parentId?: string
): Promise<IMessageMessage> =>
  part.type === "text"
    ? buildTextMessage(base, part.text, id, partIndex, parentId)
    : await buildAttachmentMessage(
        client,
        base,
        part.attachment,
        id,
        partIndex,
        parentId
      );

const buildContentMessage = async (
  client: AdvancedIMessage,
  base: RemoteMessageBase,
  message: AppleMessage,
  messageGuidStr: string
): Promise<IMessageMessage> => {
  const attachments = messageAttachments(message);

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
    return buildOrderedPartMessage(client, base, part, messageGuidStr, 0);
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
        messageGuidStr
      )
    );
  }

  return {
    ...base,
    id: messageGuidStr,
    content: asProviderGroup(items),
  };
};

export const rebuildFromAppleMessage = async (
  client: AdvancedIMessage,
  message: AppleMessage,
  phone: string,
  chatGuidHint?: string
): Promise<IMessageMessage> => {
  const messageGuidStr = message.guid as string;
  const timestamp = message.dateCreated ?? new Date();
  const base = buildMessageBase(message, chatGuidHint, timestamp, phone);
  return buildContentMessage(client, base, message, messageGuidStr);
};

export const cacheMessage = (
  cache: MessageCache,
  message: IMessageMessage
): void => {
  cache.set(message.id, message);
  if (message.content.type === "group") {
    for (const item of message.content.items) {
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
    messageGuidStr
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
        spaceId
      );
      cacheMessage(cache, parent);
      if (parent.content.type !== "group") {
        return;
      }
      const item = parent.content.items[childRef.partIndex];
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
      spaceId
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
