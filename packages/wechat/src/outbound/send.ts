import { randomUUID } from "node:crypto";
import { type Content, UnsupportedError } from "@spectrum-ts/core";
import {
  createLogger,
  errorAttrs,
  type ProviderMessageRecord,
} from "@spectrum-ts/core/authoring";
import { getTypingTicket, sendMessage, sendTyping } from "../api";
import {
  assertSessionActive,
  pauseSession,
  remainingPauseMs,
  type WeChatClient,
} from "../client";
import { WECHAT_PLATFORM } from "../config";
import { WeChatApiError, WeChatContextTokenError } from "../errors";
import {
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
} from "../types";

const log = createLogger("spectrum.wechat");

/** How long a `getconfig` typing ticket is reused (Tencent's client refreshes within a day). */
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

type TextContent = Extract<Content, { type: "text" }>;

// A business-level rejection (not HTTP, not an expired session) of a send
// that carried no context token is attributed to the missing token.
const isContextRejection = (error: unknown): error is WeChatApiError =>
  error instanceof WeChatApiError &&
  error.status === undefined &&
  !error.sessionExpired;

/**
 * Send one text message. iLink expects each reply to echo the `context_token`
 * from the user's latest inbound message; when none is cached the send is
 * still attempted (as Tencent's client does), and a rejection surfaces as
 * `WeChatContextTokenError`.
 */
const sendText = async (
  client: WeChatClient,
  userId: string,
  content: TextContent
): Promise<ProviderMessageRecord> => {
  assertSessionActive(client);
  const contextToken = client.state.contextToken(userId);
  if (!contextToken) {
    log.warn(
      "No WeChat context_token cached for this user; sending without one"
    );
  }
  const clientId = `spectrum-wechat:${randomUUID()}`;
  let messageId: string | undefined;
  try {
    const response = await sendMessage(client.target, {
      from_user_id: "",
      to_user_id: userId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: content.text } },
      ],
      ...(contextToken ? { context_token: contextToken } : {}),
    });
    messageId = response.message_id;
  } catch (error) {
    if (error instanceof WeChatApiError && error.sessionExpired) {
      pauseSession(client);
    }
    if (!contextToken && isContextRejection(error)) {
      throw new WeChatContextTokenError(userId, { cause: error });
    }
    throw error;
  }
  return {
    id: messageId || clientId,
    content,
    space: { id: userId },
    timestamp: new Date(),
  };
};

const typingTicket = async (
  client: WeChatClient,
  userId: string
): Promise<string | undefined> => {
  const cached = client.typingTickets.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ticket;
  }
  const ticket = await getTypingTicket(
    client.target,
    userId,
    client.state.contextToken(userId)
  );
  if (ticket) {
    client.typingTickets.set(userId, {
      ticket,
      expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
    });
  }
  return ticket;
};

/** Typing is a hint: failures are logged and swallowed, never thrown. */
const sendTypingState = async (
  client: WeChatClient,
  userId: string,
  state: "start" | "stop"
): Promise<void> => {
  if (remainingPauseMs(client) > 0) {
    return;
  }
  try {
    const ticket = await typingTicket(client, userId);
    if (!ticket) {
      return;
    }
    await sendTyping(
      client.target,
      userId,
      ticket,
      state === "start" ? TypingStatus.TYPING : TypingStatus.CANCEL
    );
  } catch (error) {
    log.warn("WeChat typing indicator failed; ignoring", errorAttrs(error));
  }
};

/**
 * Outbound dispatcher. v1 sends text and typing indicators; anything else
 * throws `UnsupportedError`, which core turns into a plain-text fallback for
 * `markdown` / `streamText` and a warning for the rest.
 */
export const send = async ({
  client,
  content,
  space,
}: {
  client: WeChatClient;
  content: Content;
  space: { id: string };
}): Promise<ProviderMessageRecord | undefined> => {
  if (content.type === "text") {
    return await sendText(client, space.id, content);
  }
  if (content.type === "typing") {
    await sendTypingState(client, space.id, content.state);
    return;
  }
  throw UnsupportedError.content(content.type, WECHAT_PLATFORM);
};
