import type { Store } from "@spectrum-ts/core";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";
import { type ApiTarget, notifyStart, notifyStop } from "./api";
import type { WeChatConfig } from "./config";
import { WeChatSessionPausedError } from "./errors";
import { loginWithQrCode } from "./login";
import { openState, type WeChatState } from "./state";
import type { WeChatCredentials } from "./types";

const log = createLogger("spectrum.wechat");

/** After a session-expired (-14) response, Tencent's client stops calling iLink for an hour. */
export const SESSION_PAUSE_MS = 60 * 60 * 1000;
const LIFECYCLE_TIMEOUT_MS = 10_000;

/** Per-user `sendtyping` tickets from `getconfig`. */
export interface TypingTicket {
  expiresAt: number;
  ticket: string;
}

export interface WeChatClient {
  /** End of the current session-expired pause (epoch ms), if any. */
  pausedUntil?: number;
  /** Aborted by `destroyClient`: cancels in-flight long-polls and back-offs. */
  readonly shutdown: AbortController;
  readonly state: WeChatState;
  readonly target: ApiTarget;
  readonly typingTickets: Map<string, TypingTicket>;
}

/** Milliseconds left in a session-expired pause (0 when not paused). */
export const remainingPauseMs = (client: WeChatClient): number =>
  Math.max(0, (client.pausedUntil ?? 0) - Date.now());

export const pauseSession = (client: WeChatClient): void => {
  client.pausedUntil = Date.now() + SESSION_PAUSE_MS;
};

/** Fail fast instead of calling iLink while the session is paused. */
export const assertSessionActive = (client: WeChatClient): void => {
  if (remainingPauseMs(client) > 0) {
    throw new WeChatSessionPausedError(new Date(client.pausedUntil ?? 0));
  }
};

const configuredCredentials = (
  config: WeChatConfig,
  saved: WeChatCredentials | undefined
): WeChatCredentials | undefined => {
  if (!config.botToken) {
    return;
  }
  // Keep what the login recorded (bot / owner ids) for the same token.
  const extras = saved?.botToken === config.botToken ? saved : {};
  return { ...extras, botToken: config.botToken, baseUrl: config.baseUrl };
};

/**
 * Resolve credentials — explicit `botToken`, else the state file, else an
 * interactive QR login — then announce the client to iLink.
 */
export const createClient = async ({
  config,
  signal,
  store,
}: {
  config: WeChatConfig;
  signal?: AbortSignal;
  store: Store;
}): Promise<WeChatClient> => {
  const state = await openState(store, config.stateFile);
  const credentials =
    configuredCredentials(config, state.credentials()) ??
    state.credentials() ??
    (await loginWithQrCode({
      ...config.login,
      baseUrl: config.baseUrl,
      signal,
    }));
  state.setCredentials(credentials);
  await state.save();

  const target = {
    baseUrl: credentials.baseUrl,
    botToken: credentials.botToken,
  };
  try {
    await notifyStart(target, { signal, timeoutMs: LIFECYCLE_TIMEOUT_MS });
  } catch (error) {
    signal?.throwIfAborted();
    log.warn("WeChat notifystart failed; continuing", errorAttrs(error));
  }
  return {
    shutdown: new AbortController(),
    state,
    target,
    typingTickets: new Map(),
  };
};

/** Stop polling, tell iLink the client is leaving, and flush the state file. */
export const destroyClient = async ({
  client,
}: {
  client: WeChatClient;
}): Promise<void> => {
  client.shutdown.abort();
  if (remainingPauseMs(client) === 0) {
    try {
      await notifyStop(client.target, { timeoutMs: LIFECYCLE_TIMEOUT_MS });
    } catch (error) {
      log.warn("WeChat notifystop failed", errorAttrs(error));
    }
  }
  await client.state.save();
};
