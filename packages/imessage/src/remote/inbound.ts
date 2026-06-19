import {
  type AdvancedIMessage,
  type MessageEvent,
  NotFoundError,
} from "@photon-ai/advanced-imessage";
import { type Content, fromVCard, type Group } from "@spectrum-ts/core";
import {
  asAttachment,
  asContact,
  asCustom,
  asRichlink,
  asText,
  createLogger,
  errorAttrs,
  groupSchema,
} from "@spectrum-ts/core/authoring";
import { getMessageCache, type MessageCache } from "../cache";
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

const URL_BALLOON_BUNDLE_ID = "com.apple.messages.URLBalloonProvider";

export type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;
export type AppleMessage = ReceivedEvent["message"];
type AppleAttachment = AppleMessage["content"]["attachments"][number];
export type RemoteMessageBase = Omit<IMessageMessage, "id" | "content">;

const getBalloonBundleId = (message: AppleMessage): string | undefined =>
  message.content.balloonBundleId;

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

const resolveSenderId = (message: AppleMessage): string =>
  message.sender?.address ?? "";

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
    sender: { id: resolveSenderId(message) },
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

const toRichlinkMessage = (
  message: AppleMessage,
  base: RemoteMessageBase,
  id: string
): IMessageMessage => {
  const url = message.content.text ?? "";
  try {
    return { ...base, id, content: asRichlink({ url }) };
  } catch (err) {
    log.warn(
      "failed to convert message to rich link; falling back to text/custom content",
      { "spectrum.imessage.message.id": id, ...errorAttrs(err) },
      err
    );
    return {
      ...base,
      id,
      content: url ? asText(url) : asCustom(message),
    };
  }
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

  const attachments = messageAttachments(message);

  if (attachments.length === 1) {
    const info = attachments[0];
    if (!info) {
      throw new Error("Unreachable: attachments.length === 1 but no element");
    }
    return buildAttachmentMessage(client, base, info, messageGuidStr, 0);
  }

  if (attachments.length > 1) {
    const items: IMessageMessage[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const info = attachments[i];
      if (!info) {
        continue;
      }
      items.push(
        await buildAttachmentMessage(
          client,
          base,
          info,
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
  }

  if (getBalloonBundleId(message) === URL_BALLOON_BUNDLE_ID) {
    return toRichlinkMessage(message, base, messageGuidStr);
  }

  const text = message.content.text;
  return {
    ...base,
    id: messageGuidStr,
    content: text ? asText(text) : asCustom(message),
  };
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

  if (getBalloonBundleId(event.message) === URL_BALLOON_BUNDLE_ID) {
    const msg = toRichlinkMessage(event.message, base, messageGuidStr);
    cacheMessage(cache, msg);
    return [msg];
  }

  const attachments = messageAttachments(event.message);

  if (attachments.length === 1) {
    const info = attachments[0];
    if (!info) {
      throw new Error("Unreachable: attachments.length === 1 but no element");
    }
    const msg = await buildAttachmentMessage(
      client,
      base,
      info,
      messageGuidStr,
      0
    );
    cacheMessage(cache, msg);
    return [msg];
  }

  if (attachments.length > 1) {
    const items: IMessageMessage[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const info = attachments[i];
      if (!info) {
        continue;
      }
      items.push(
        await buildAttachmentMessage(
          client,
          base,
          info,
          formatChildId(i, messageGuidStr),
          i,
          messageGuidStr
        )
      );
    }
    const parent: IMessageMessage = {
      ...base,
      id: messageGuidStr,
      content: asProviderGroup(items),
    };
    cacheMessage(cache, parent);
    return [parent];
  }

  const text = event.message.content.text;
  const msg: IMessageMessage = {
    ...base,
    id: messageGuidStr,
    content: text ? asText(text) : asCustom(event.message),
  };
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
