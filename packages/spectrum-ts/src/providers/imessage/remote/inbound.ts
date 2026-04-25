import {
  type AdvancedIMessage,
  type MessageEvent,
  messageGuid,
} from "@photon-ai/advanced-imessage";
import { asAttachment } from "../../../content/attachment";
import { asContact } from "../../../content/contact";
import { asCustom } from "../../../content/custom";
import { asGroup } from "../../../content/group";
import { asRichlink } from "../../../content/richlink";
import { asText } from "../../../content/text";
import type { Content } from "../../../content/types";
import type { Message } from "../../../types/message";
import { fromVCard } from "../../../utils/vcard";
import { getMessageCache, type MessageCache } from "../cache";
import { isVCardAttachment } from "../shared/vcard";
import type { IMessageMessage } from "../types";
import { formatChildId, parseChildId } from "./ids";

const URL_BALLOON_BUNDLE_ID = "com.apple.messages.URLBalloonProvider";

export type ReceivedEvent = Extract<MessageEvent, { type: "message.received" }>;
export type AppleMessage = ReceivedEvent["message"];
type AppleAttachment = AppleMessage["attachments"][number];
export type RemoteMessageBase = Omit<IMessageMessage, "id" | "content">;

const getBalloonBundleId = (message: AppleMessage): string | undefined => {
  const raw = (message as { _raw?: { balloonBundleId?: unknown } })._raw;
  const id = raw?.balloonBundleId;
  return typeof id === "string" ? id : undefined;
};

// `Message$1` from the SDK (fetched via `messages.get`) lacks the ambient
// chatGuid that inbound events carry; fall back to the first chat the message
// belongs to.
const resolveChatGuid = (
  message: AppleMessage,
  hint: string | undefined
): string => {
  if (hint) {
    return hint;
  }
  const first = message.chatGuids?.[0];
  return (first as unknown as string | undefined) ?? "";
};

const resolveSenderId = (message: AppleMessage): string =>
  message.sender?.address ?? "";

export const buildMessageBase = (
  message: AppleMessage,
  chatGuidHint: string | undefined,
  timestamp: Date
): RemoteMessageBase => {
  const chat = resolveChatGuid(message, chatGuidHint);
  return {
    sender: { id: resolveSenderId(message) },
    space: {
      id: chat,
      type: chat.includes(";+;") ? "group" : "dm",
    },
    timestamp,
  };
};

const toAttachmentContent = (
  client: AdvancedIMessage,
  info: AppleAttachment
): Content =>
  asAttachment({
    name: info.fileName,
    mimeType: info.mimeType,
    size: info.totalBytes,
    read: async () =>
      Buffer.from(await client.attachments.downloadBuffer(info.guid)),
    stream: async () => client.attachments.download(info.guid).stream,
  });

const toVCardContent = async (
  client: AdvancedIMessage,
  info: AppleAttachment
): Promise<Content> => {
  try {
    const buf = Buffer.from(await client.attachments.downloadBuffer(info.guid));
    return asContact(fromVCard(buf.toString("utf8")));
  } catch {
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
  const url = message.text ?? "";
  try {
    return { ...base, id, content: asRichlink({ url }) };
  } catch {
    return {
      ...base,
      id,
      content: url ? asText(url) : asCustom(message),
    };
  }
};

// Rebuilds an `IMessageMessage` (or a group) from an Apple SDK message that
// did not arrive via the live stream. Used on reaction cache miss and by
// getMessage.
export const rebuildFromAppleMessage = async (
  client: AdvancedIMessage,
  message: AppleMessage,
  chatGuidHint?: string
): Promise<IMessageMessage> => {
  const messageGuidStr = message.guid as string;
  const timestamp = message.dateCreated ?? new Date();
  const base = buildMessageBase(message, chatGuidHint, timestamp);

  if (message.attachments.length === 1) {
    const info = message.attachments[0];
    if (!info) {
      throw new Error("Unreachable: attachments.length === 1 but no element");
    }
    return buildAttachmentMessage(client, base, info, messageGuidStr, 0);
  }

  if (message.attachments.length > 1) {
    const items: IMessageMessage[] = [];
    for (let i = 0; i < message.attachments.length; i++) {
      const info = message.attachments[i];
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
      content: asGroup({ items: items as unknown as Message[] }),
    };
  }

  if (getBalloonBundleId(message) === URL_BALLOON_BUNDLE_ID) {
    return toRichlinkMessage(message, base, messageGuidStr);
  }

  const text = message.text;
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
    for (const item of message.content.items as unknown as IMessageMessage[]) {
      cache.set(item.id, item);
    }
  }
};

export const toInboundMessages = async (
  client: AdvancedIMessage,
  cache: MessageCache,
  event: ReceivedEvent
): Promise<IMessageMessage[]> => {
  const base = buildMessageBase(event.message, event.chatGuid, event.timestamp);
  const messageGuidStr = event.message.guid as string;

  if (getBalloonBundleId(event.message) === URL_BALLOON_BUNDLE_ID) {
    const msg = toRichlinkMessage(event.message, base, messageGuidStr);
    cacheMessage(cache, msg);
    return [msg];
  }

  if (event.message.attachments.length === 1) {
    const info = event.message.attachments[0];
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

  if (event.message.attachments.length > 1) {
    const items: IMessageMessage[] = [];
    for (let i = 0; i < event.message.attachments.length; i++) {
      const info = event.message.attachments[i];
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
      content: asGroup({ items: items as unknown as Message[] }),
    };
    cacheMessage(cache, parent);
    return [parent];
  }

  const text = event.message.text;
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
  msgId: string
): Promise<IMessageMessage | undefined> => {
  const cache = getMessageCache(remote);
  const cached = cache.get(msgId);
  if (cached) {
    return cached;
  }

  // Group-child ids use the `p:<partIndex>/<parentGuid>` format (same as
  // Apple tapback targets). The SDK's `messages.get` only accepts parent
  // guids, so decode the id and descend into the parent's items.
  const childRef = parseChildId(msgId);
  if (childRef) {
    try {
      const fetched = await remote.messages.get(
        messageGuid(childRef.parentGuid)
      );
      const parent = await rebuildFromAppleMessage(remote, fetched, spaceId);
      cacheMessage(cache, parent);
      if (parent.content.type !== "group") {
        return;
      }
      const items = parent.content.items as unknown as IMessageMessage[];
      return items[childRef.partIndex];
    } catch {
      return;
    }
  }

  try {
    const fetched = await remote.messages.get(messageGuid(msgId));
    const rebuilt = await rebuildFromAppleMessage(remote, fetched, spaceId);
    cacheMessage(cache, rebuilt);
    return rebuilt;
  } catch {
    return;
  }
};
