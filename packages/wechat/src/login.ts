import { setTimeout as sleep } from "node:timers/promises";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";
import { getBotQrCode, getQrCodeStatus, isTimeoutError } from "./api";
import {
  DEFAULT_BASE_URL,
  DEFAULT_LOGIN_TIMEOUT_MS,
  type QrCodeHandler,
  type VerifyCodeHandler,
} from "./config";
import { WeChatLoginError } from "./errors";
import type { QrStatusResponse, WeChatCredentials } from "./types";

const log = createLogger("spectrum.wechat");

const DEFAULT_POLL_INTERVAL_MS = 1000;
/** Client-side cap on one `get_qrcode_status` long-poll. */
const STATUS_POLL_TIMEOUT_MS = 35_000;
/** A QR code that expires is replaced this many times in total. */
const MAX_QR_CODES = 3;

export interface LoginOptions {
  /** iLink origin to start the login at. Default `https://ilinkai.weixin.qq.com`. */
  baseUrl?: string;
  /** Show the QR code to the user; defaults to logging its URL. */
  onQrCode?: QrCodeHandler;
  /** Ask for the number WeChat displays when it requires verification. */
  onVerifyCode?: VerifyCodeHandler;
  /** Delay between status polls. Default 1000 ms. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Give up after this long. Default 8 minutes. */
  timeoutMs?: number;
}

interface LoginContext {
  baseUrl: string;
  onQrCode: QrCodeHandler;
  onVerifyCode?: VerifyCodeHandler;
  signal?: AbortSignal;
}

interface LoginState {
  pollBaseUrl: string;
  qrCodesShown: number;
  qrcode: string;
  status?: string;
  verifyCode?: string;
}

const logQrCode: QrCodeHandler = (qrCodeUrl) => {
  log.info(
    `Scan this QR code with WeChat to connect the bot (render the link as a QR code, or open it): ${qrCodeUrl}`
  );
};

const showNextQrCode = async (
  state: LoginState,
  ctx: LoginContext
): Promise<void> => {
  if (state.qrCodesShown >= MAX_QR_CODES) {
    throw new WeChatLoginError(
      `WeChat QR login abandoned after ${MAX_QR_CODES} QR codes expired.`,
      state.status
    );
  }
  const response = await getBotQrCode(ctx.baseUrl, { signal: ctx.signal });
  if (!(response.qrcode && response.qrcode_img_content)) {
    throw new WeChatLoginError("iLink returned no QR code to scan.");
  }
  state.qrcode = response.qrcode;
  state.qrCodesShown += 1;
  state.pollBaseUrl = ctx.baseUrl;
  state.verifyCode = undefined;
  await ctx.onQrCode(response.qrcode_img_content);
};

// A status poll that times out or fails at the network level just means "no
// news yet" — Tencent's client treats both as `wait` and polls again.
const pollStatus = async (
  state: LoginState,
  ctx: LoginContext,
  remainingMs: number
): Promise<QrStatusResponse> => {
  try {
    return await getQrCodeStatus(
      state.pollBaseUrl,
      state.qrcode,
      state.verifyCode,
      {
        signal: ctx.signal,
        timeoutMs: Math.max(1, Math.min(STATUS_POLL_TIMEOUT_MS, remainingMs)),
      }
    );
  } catch (error) {
    ctx.signal?.throwIfAborted();
    if (!isTimeoutError(error)) {
      log.warn("WeChat QR status poll failed; retrying", errorAttrs(error));
    }
    return { status: "wait" };
  }
};

const requestVerifyCode = async (
  state: LoginState,
  ctx: LoginContext
): Promise<string> => {
  if (!ctx.onVerifyCode) {
    throw new WeChatLoginError(
      "WeChat asked for the verification number shown on the phone; pass login.onVerifyCode to supply it.",
      state.status
    );
  }
  if (state.verifyCode) {
    log.warn("WeChat rejected the verification number; asking again");
  }
  return (await ctx.onVerifyCode()).trim();
};

const confirmedCredentials = (
  response: QrStatusResponse,
  baseUrl: string
): WeChatCredentials => {
  if (!(response.bot_token && response.ilink_bot_id)) {
    throw new WeChatLoginError(
      "WeChat confirmed the login but returned no bot token.",
      response.status
    );
  }
  return {
    botToken: response.bot_token,
    baseUrl: response.baseurl || baseUrl,
    botId: response.ilink_bot_id,
    ...(response.ilink_user_id ? { ownerId: response.ilink_user_id } : {}),
  };
};

/** Apply one status poll; resolves credentials once the login is confirmed. */
const handleStatus = async (
  response: QrStatusResponse,
  state: LoginState,
  ctx: LoginContext
): Promise<WeChatCredentials | undefined> => {
  state.status = response.status;
  switch (response.status) {
    case "confirmed":
      return confirmedCredentials(response, ctx.baseUrl);
    case "scaned":
      // Scanned (or a submitted verification number was accepted); waiting
      // for the user to confirm on the phone.
      state.verifyCode = undefined;
      return;
    case "scaned_but_redirect":
      if (response.redirect_host) {
        state.pollBaseUrl = `https://${response.redirect_host}`;
      }
      return;
    case "need_verifycode":
      state.verifyCode = await requestVerifyCode(state, ctx);
      return;
    case "expired":
    case "verify_code_blocked":
      await showNextQrCode(state, ctx);
      return;
    case "binded_redirect":
      throw new WeChatLoginError(
        "This WeChat account is already connected to a bot session; reuse its saved botToken instead of scanning again.",
        response.status
      );
    default:
      // `wait`, or a status this client does not know: keep polling.
      return;
  }
};

/**
 * Run iLink's QR login: fetch a QR code, hand it to `onQrCode`, and poll until
 * the user scans and confirms in WeChat. Expired codes are replaced (up to
 * three codes in total) and cross-region redirects are followed. Resolves the
 * credentials to save; rejects with `WeChatLoginError` on failure or timeout.
 *
 * Use it standalone to obtain a `botToken` ahead of time, or let the provider
 * call it from `createClient` when no token is configured.
 */
export const loginWithQrCode = async (
  options: LoginOptions = {}
): Promise<WeChatCredentials> => {
  const ctx: LoginContext = {
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    onQrCode: options.onQrCode ?? logQrCode,
    onVerifyCode: options.onVerifyCode,
    signal: options.signal,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const state: LoginState = {
    pollBaseUrl: ctx.baseUrl,
    qrCodesShown: 0,
    qrcode: "",
  };

  await showNextQrCode(state, ctx);
  while (Date.now() < deadline) {
    // Surface the caller's abort reason rather than a generic AbortError.
    ctx.signal?.throwIfAborted();
    const response = await pollStatus(state, ctx, deadline - Date.now());
    const credentials = await handleStatus(response, state, ctx);
    if (credentials) {
      return credentials;
    }
    await sleep(pollIntervalMs, undefined, { signal: ctx.signal }).catch(
      () => undefined
    );
  }
  throw new WeChatLoginError(
    `WeChat QR login timed out after ${timeoutMs} ms.`,
    state.status
  );
};
