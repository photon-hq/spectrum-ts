import LinqAPIV3 from "@linqapp/sdk";
import type { SupportedContentType } from "@linqapp/sdk/resources/attachments";
import type { LinqConfig } from "./config";
import { fetchBytes } from "./http";
import type {
  LinqOutboundMessage,
  LinqOutboundPart,
  LinqReactionInput,
  LinqUploadInput,
} from "./types";

const CLIENT_STORE_KEY = "linq.client";

/**
 * The adapter's view of LinQ's HTTP API. Wraps `@linqapp/sdk` so `send` /
 * inbound code depends on a small, stable surface rather than SDK request
 * shapes. A raw `fetch` handles the presigned-upload PUT and media downloads
 * (presigned URLs need no auth).
 */
export interface LinqClient {
  addReaction(messageId: string, input: LinqReactionInput): Promise<void>;
  createChat(input: {
    from: string;
    to: string[];
    message: LinqOutboundMessage;
  }): Promise<{ chatId: string; messageId: string }>;
  downloadMedia(url: string): Promise<Buffer>;
  editMessage(
    messageId: string,
    input: { text: string; partIndex?: number }
  ): Promise<void>;
  sendMessage(
    chatId: string,
    message: LinqOutboundMessage
  ): Promise<{ messageId: string }>;
  sendVoicememo(
    chatId: string,
    input: { attachmentId?: string; voiceMemoUrl?: string }
  ): Promise<{ voiceMemoId: string }>;
  startTyping(chatId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
  updateChat(
    chatId: string,
    input: { displayName?: string; groupChatIcon?: string }
  ): Promise<void>;
  uploadAttachment(
    input: LinqUploadInput
  ): Promise<{ attachmentId: string; downloadUrl: string }>;
}

const toPart = (part: LinqOutboundPart) => {
  switch (part.type) {
    case "text":
      return { type: "text" as const, value: part.value };
    case "link":
      return { type: "link" as const, value: part.value };
    case "media":
      return {
        type: "media" as const,
        ...(part.attachmentId ? { attachment_id: part.attachmentId } : {}),
        ...(part.url ? { url: part.url } : {}),
      };
    default:
      return part satisfies never;
  }
};

const toMessageContent = (message: LinqOutboundMessage) => ({
  parts: message.parts.map(toPart),
  ...(message.effect ? { effect: message.effect } : {}),
  ...(message.idempotencyKey
    ? { idempotency_key: message.idempotencyKey }
    : {}),
  ...(message.preferredService
    ? { preferred_service: message.preferredService }
    : {}),
  ...(message.replyTo
    ? {
        reply_to: {
          message_id: message.replyTo.messageId,
          ...(message.replyTo.partIndex === undefined
            ? {}
            : { part_index: message.replyTo.partIndex }),
        },
      }
    : {}),
});

const makeLinqClient = (config: LinqConfig): LinqClient => {
  const sdk = new LinqAPIV3({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  return {
    createChat: async ({ from, to, message }) => {
      const { chat } = await sdk.chats.create({
        from,
        to,
        message: toMessageContent(message),
      });
      return { chatId: chat.id, messageId: chat.message.id };
    },

    sendMessage: async (chatId, message) => {
      const { message: sent } = await sdk.chats.messages.send(chatId, {
        message: toMessageContent(message),
      });
      return { messageId: sent.id };
    },

    uploadAttachment: async ({ filename, contentType, bytes }) => {
      const created = await sdk.attachments.create({
        filename,
        content_type: contentType as SupportedContentType,
        size_bytes: bytes.byteLength,
      });
      const uploaded = await fetch(created.upload_url, {
        method: created.http_method,
        headers: created.required_headers,
        body: new Uint8Array(bytes),
      });
      if (!uploaded.ok) {
        throw new Error(
          `LinQ attachment upload failed: ${uploaded.status} ${uploaded.statusText}`
        );
      }
      return {
        attachmentId: created.attachment_id,
        downloadUrl: created.download_url,
      };
    },

    sendVoicememo: async (chatId, { attachmentId, voiceMemoUrl }) => {
      const { voice_memo } = await sdk.chats.sendVoicememo(chatId, {
        ...(attachmentId ? { attachment_id: attachmentId } : {}),
        ...(voiceMemoUrl ? { voice_memo_url: voiceMemoUrl } : {}),
      });
      return { voiceMemoId: voice_memo.id };
    },

    addReaction: async (
      messageId,
      { operation, type, customEmoji, partIndex }
    ) => {
      await sdk.messages.addReaction(messageId, {
        operation,
        type,
        ...(customEmoji ? { custom_emoji: customEmoji } : {}),
        ...(partIndex === undefined ? {} : { part_index: partIndex }),
      });
    },

    editMessage: async (messageId, { text, partIndex }) => {
      await sdk.messages.update(messageId, {
        text,
        ...(partIndex === undefined ? {} : { part_index: partIndex }),
      });
    },

    startTyping: async (chatId) => {
      await sdk.chats.typing.start(chatId);
    },

    stopTyping: async (chatId) => {
      await sdk.chats.typing.stop(chatId);
    },

    updateChat: async (chatId, { displayName, groupChatIcon }) => {
      await sdk.chats.update(chatId, {
        ...(displayName === undefined ? {} : { display_name: displayName }),
        ...(groupChatIcon === undefined
          ? {}
          : { group_chat_icon: groupChatIcon }),
      });
    },

    downloadMedia: (url) => fetchBytes(url),
  };
};

// Store is an SDK-internal KV reachable through lifecycle/send ctx. It isn't
// exported from spectrum-ts, so we depend on its minimal structural shape.
export interface StoreLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Build the outbound client once (in `createClient`) and cache it on `store`. */
export const initClient = (
  store: StoreLike,
  config: LinqConfig
): LinqClient => {
  const client = makeLinqClient(config);
  store.set(CLIENT_STORE_KEY, client);
  return client;
};

/** Read the cached client in `send`/actions, rebuilding it if absent. */
export const getClient = (store: StoreLike, config: LinqConfig): LinqClient =>
  (store.get(CLIENT_STORE_KEY) as LinqClient | undefined) ??
  initClient(store, config);
