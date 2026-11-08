import type { ProviderMessage } from "@spectrum-ts/core";

// ---------------------------------------------------------------------------
// iLink wire format — only the fields this provider reads or writes. Field
// names and enum values follow Tencent's protocol reference
// (openclaw-weixin `docs/protocol.md`); every field is optional on the wire.
// ---------------------------------------------------------------------------

/** `WeixinMessage.message_type`: who authored the message. */
export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

/** `WeixinMessage.message_state`: outbound messages are always sent finished. */
export const MessageState = {
  FINISH: 2,
} as const;

/** `MessageItem.type`. Only text is mapped in v1; media items are skipped. */
export const MessageItemType = {
  TEXT: 1,
} as const;

/** `sendtyping` status. */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

/** Business-level result fields; `ret: 0` (or absent) means success. */
export interface ILinkResult {
  errcode?: number;
  errmsg?: string;
  ret?: number;
}

export interface MessageItem {
  text_item?: { text?: string };
  type?: number;
}

export interface WeixinMessage {
  client_id?: string;
  /** Echoed back on every reply to this user; see `outbound/send.ts`. */
  context_token?: string;
  create_time_ms?: number;
  from_user_id?: string;
  group_id?: string;
  item_list?: MessageItem[];
  /** uint64 on the wire; parsed losslessly as a string (see `parseILinkJson`). */
  message_id?: string;
  message_state?: number;
  message_type?: number;
  seq?: number;
  to_user_id?: string;
}

export interface GetUpdatesResponse extends ILinkResult {
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  msgs?: WeixinMessage[];
}

export interface SendMessageResponse extends ILinkResult {
  message_id?: string;
}

export interface GetConfigResponse extends ILinkResult {
  typing_ticket?: string;
}

export interface QrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrStatusResponse {
  baseurl?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Spectrum-side shapes.
// ---------------------------------------------------------------------------

/** What a successful QR login yields — everything needed to reconnect. */
export interface WeChatCredentials {
  /** API origin to use with this token (the login may redirect to another). */
  baseUrl: string;
  /** The bot's own iLink account id (`ilink_bot_id`), when known. */
  botId?: string;
  botToken: string;
  /** iLink user id of the WeChat account that scanned the QR code. */
  ownerId?: string;
}

/** An inbound 1:1 message: the space id is the sender's iLink user id. */
export type WeChatInboundMessage = ProviderMessage<
  { id: string },
  { id: string }
>;
