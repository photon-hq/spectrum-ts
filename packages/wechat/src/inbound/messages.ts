import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type ManagedStream, stream } from "@spectrum-ts/core";
import { asText, createLogger, errorAttrs } from "@spectrum-ts/core/authoring";
import { getUpdates, isTimeoutError } from "../api";
import {
  pauseSession,
  remainingPauseMs,
  SESSION_PAUSE_MS,
  type WeChatClient,
} from "../client";
import { WeChatApiError } from "../errors";
import type { WeChatState } from "../state";
import {
  type MessageItem,
  MessageItemType,
  MessageType,
  type WeChatInboundMessage,
  type WeixinMessage,
} from "../types";

const log = createLogger("spectrum.wechat");

/** Used until the server suggests its own `longpolling_timeout_ms`. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
// Let the server answer at the very end of its own long-poll window before
// the client-side timeout fires.
const LONG_POLL_GRACE_MS = 5000;

/** Retry policy for failed `getupdates` calls (Tencent's client uses the same). */
export interface PollTimings {
  backoffDelayMs: number;
  maxConsecutiveFailures: number;
  retryDelayMs: number;
}

export const DEFAULT_POLL_TIMINGS: PollTimings = {
  backoffDelayMs: 30_000,
  maxConsecutiveFailures: 3,
  retryDelayMs: 2000,
};

const textOf = (items: MessageItem[] = []): string =>
  items
    .filter((item) => item.type === MessageItemType.TEXT)
    .map((item) => item.text_item?.text ?? "")
    .filter(Boolean)
    .join("\n");

const messageId = (message: WeixinMessage, from: string): string => {
  if (message.message_id) {
    return message.message_id;
  }
  const position = message.seq ?? message.create_time_ms;
  return position === undefined ? randomUUID() : `${from}:${position}`;
};

/**
 * Map one `getupdates` message to a Spectrum record, caching the sender's
 * `context_token` on the way. v1 surfaces 1:1 text: the bot's own messages,
 * group messages and items without text (media) are dropped. The space id is
 * the sender's iLink user id, so replying goes straight back to them.
 */
export const toInboundMessage = (
  message: WeixinMessage,
  state: WeChatState
): WeChatInboundMessage | undefined => {
  const from = message.from_user_id;
  if (!from || message.message_type === MessageType.BOT || message.group_id) {
    return;
  }
  if (message.context_token) {
    state.setContextToken(from, message.context_token);
  }
  const text = textOf(message.item_list);
  if (!text) {
    return;
  }
  return {
    id: messageId(message, from),
    content: asText(text),
    sender: { id: from },
    space: { id: from },
    ...(message.create_time_ms === undefined
      ? {}
      : { timestamp: new Date(message.create_time_ms) }),
  };
};

/** Sleep that resolves early (instead of rejecting) when `signal` aborts. */
const waitFor = async (ms: number, signal: AbortSignal): Promise<void> => {
  await sleep(ms, undefined, { signal }).catch(() => undefined);
};

// Returns the updated consecutive-failure count.
const recoverFromPollError = async (
  error: unknown,
  failures: number,
  client: WeChatClient,
  signal: AbortSignal,
  timings: PollTimings
): Promise<number> => {
  if (error instanceof WeChatApiError && error.sessionExpired) {
    pauseSession(client);
    log.error(
      `WeChat session expired; pausing API calls for ${SESSION_PAUSE_MS / 60_000} minutes. Remove the saved botToken (and state file) and restart to scan a new QR code.`,
      errorAttrs(error)
    );
    return 0;
  }
  const attempt = failures + 1;
  const backOff = attempt >= timings.maxConsecutiveFailures;
  const delayMs = backOff ? timings.backoffDelayMs : timings.retryDelayMs;
  log.warn(
    `WeChat getupdates failed (${attempt}/${timings.maxConsecutiveFailures}); retrying in ${delayMs} ms`,
    errorAttrs(error)
  );
  await waitFor(delayMs, signal);
  return backOff ? 0 : attempt;
};

const saveState = async (state: WeChatState): Promise<void> => {
  try {
    await state.save();
  } catch (error) {
    log.warn("Failed to write the WeChat state file", errorAttrs(error));
  }
};

/**
 * The `getupdates` long-poll loop. Each batch is emitted before its cursor is
 * saved, so a crash replays messages rather than losing them. Runs until
 * `signal` aborts; transport and API failures are retried with back-off.
 */
export const pollMessages = async (
  client: WeChatClient,
  emit: (message: WeChatInboundMessage) => Promise<void>,
  signal: AbortSignal,
  timings: PollTimings = DEFAULT_POLL_TIMINGS
): Promise<void> => {
  let timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let failures = 0;
  while (!signal.aborted) {
    const pausedMs = remainingPauseMs(client);
    if (pausedMs > 0) {
      await waitFor(pausedMs, signal);
      continue;
    }
    let response: Awaited<ReturnType<typeof getUpdates>>;
    try {
      response = await getUpdates(client.target, client.state.cursor(), {
        signal,
        timeoutMs: timeoutMs + LONG_POLL_GRACE_MS,
      });
    } catch (error) {
      // An empty long-poll that ran into the client-side timeout is normal.
      if (!(signal.aborted || isTimeoutError(error))) {
        failures = await recoverFromPollError(
          error,
          failures,
          client,
          signal,
          timings
        );
      }
      continue;
    }
    failures = 0;
    if (
      response.longpolling_timeout_ms &&
      response.longpolling_timeout_ms > 0
    ) {
      timeoutMs = response.longpolling_timeout_ms;
    }
    for (const message of response.msgs ?? []) {
      const inbound = toInboundMessage(message, client.state);
      if (inbound) {
        await emit(inbound);
      }
    }
    if (response.get_updates_buf) {
      client.state.setCursor(response.get_updates_buf);
    }
    await saveState(client.state);
  }
};

/**
 * Inbound stream. Closing it (or `destroyClient`) aborts the in-flight
 * long-poll, so `spectrum.stop()` never waits out a 35-second poll.
 */
export const messages = ({
  client,
}: {
  client: WeChatClient;
}): ManagedStream<WeChatInboundMessage> =>
  stream((emit, end) => {
    const closed = new AbortController();
    const signal = AbortSignal.any([closed.signal, client.shutdown.signal]);
    const loop = pollMessages(client, emit, signal).then(() => end(), end);
    return async () => {
      closed.abort();
      await loop;
    };
  });
