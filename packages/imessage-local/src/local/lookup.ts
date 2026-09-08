import type {
  IMessageSDK,
  Attachment as KitAttachment,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import type { Attachment } from "@spectrum-ts/core";
import type { IMessageMessage } from "../types";
import { localAttachmentAsAttachment } from "./attachments";
import { toMessages } from "./inbound";

const LOOKUP_PAGE_SIZE = 200;
const LOOKUP_MAX_PAGES = 50;
const MESSAGE_CACHE_LIMIT = 1000;
const ATTACHMENT_CACHE_LIMIT = 1000;

interface LocalLookupCache {
  attachments: Map<string, Attachment>;
  messages: Map<string, IMessageMessage>;
}

const caches = new WeakMap<IMessageSDK, LocalLookupCache>();

const cacheFor = (client: IMessageSDK): LocalLookupCache => {
  const existing = caches.get(client);
  if (existing) {
    return existing;
  }
  const created = {
    attachments: new Map<string, Attachment>(),
    messages: new Map<string, IMessageMessage>(),
  };
  caches.set(client, created);
  return created;
};

const lruSet = <T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number
) => {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
};

const cacheAttachment = (
  client: IMessageSDK,
  attachment: KitAttachment
): Attachment => {
  const normalized = localAttachmentAsAttachment(attachment);
  lruSet(
    cacheFor(client).attachments,
    attachment.id,
    normalized,
    ATTACHMENT_CACHE_LIMIT
  );
  return normalized;
};

export const cacheLocalMessage = async (
  client: IMessageSDK,
  source: LocalIMessage
): Promise<IMessageMessage[]> => {
  const normalized = await toMessages(source);
  const cache = cacheFor(client);
  for (const message of normalized) {
    lruSet(cache.messages, message.id, message, MESSAGE_CACHE_LIMIT);
  }
  if (normalized[0]) {
    lruSet(cache.messages, source.id, normalized[0], MESSAGE_CACHE_LIMIT);
  }
  for (const attachment of source.attachments) {
    cacheAttachment(client, attachment);
  }
  return normalized;
};

export const getLocalMessage = async (
  client: IMessageSDK,
  spaceId: string,
  messageId: string
): Promise<IMessageMessage | undefined> => {
  const cached = cacheFor(client).messages.get(messageId);
  if (cached) {
    return cached;
  }

  for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
    const rows = await client.getMessages({
      chatId: spaceId,
      limit: LOOKUP_PAGE_SIZE,
      offset: page * LOOKUP_PAGE_SIZE,
    });
    for (const row of rows) {
      const normalized = await cacheLocalMessage(client, row);
      const match = normalized.find((message) => message.id === messageId);
      if (match) {
        return match;
      }
      if (row.id === messageId) {
        return normalized[0];
      }
    }
    if (rows.length < LOOKUP_PAGE_SIZE) {
      break;
    }
  }
};

export const getLocalAttachment = async (
  client: IMessageSDK,
  attachmentId: string
): Promise<Attachment | undefined> => {
  const cached = cacheFor(client).attachments.get(attachmentId);
  if (cached) {
    return cached;
  }

  for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
    const rows = await client.getMessages({
      hasAttachments: true,
      limit: LOOKUP_PAGE_SIZE,
      offset: page * LOOKUP_PAGE_SIZE,
    });
    for (const row of rows) {
      for (const attachment of row.attachments) {
        const normalized = cacheAttachment(client, attachment);
        if (attachment.id === attachmentId) {
          return normalized;
        }
      }
    }
    if (rows.length < LOOKUP_PAGE_SIZE) {
      break;
    }
  }
};

export const getLocalDisplayName = async (
  client: IMessageSDK,
  spaceId: string
): Promise<string | undefined> => {
  const [chat] = await client.listChats({ chatId: spaceId, limit: 1 });
  return chat?.name ?? undefined;
};
