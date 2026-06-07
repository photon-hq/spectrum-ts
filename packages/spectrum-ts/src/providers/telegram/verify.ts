import { timingSafeEqual } from "node:crypto";
import type { FusorVerify, FusorVerifyRequest } from "../../fusor/types";
import type { TelegramClient } from "./client";
import type { TelegramConfig } from "./config";
import type { TelegramPayload, Update } from "./types";

/**
 * Telegram echoes the `secret_token` configured in `setWebhook` back in this
 * header (lowercased by Spectrum/Fusor). It is the ONLY inbound authentication
 * — Telegram does not HMAC-sign the request body.
 */
const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

const verifySecret = (
  headers: Record<string, string>,
  secret: string
): void => {
  const provided = headers[SECRET_TOKEN_HEADER];
  if (!provided) {
    throw new Error("Telegram webhook is missing the secret token header");
  }
  if (!safeEqual(provided, secret)) {
    throw new Error("Telegram webhook secret token mismatch");
  }
};

const isUpdate = (value: unknown): value is Update =>
  typeof value === "object" &&
  value !== null &&
  "update_id" in value &&
  typeof (value as { update_id: unknown }).update_id === "number";

const parseUpdate = (bodyText: string): Update => {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("Telegram webhook body is not valid JSON");
  }
  if (!isUpdate(json)) {
    throw new Error("Telegram webhook payload is missing a numeric update_id");
  }
  return json;
};

/**
 * Build the Fusor `verify` hook. Closes over `config` (to check the secret
 * token) and the already-built `client` (so the inbound mapper can attach
 * token-authenticated lazy media `read()` closures — the `messages` hook gets
 * only `{ payload, respond }`, with no access to the client otherwise). When no
 * `webhookSecret` is configured the token check is skipped and the body is
 * parsed directly. Throwing rejects the event (Fusor returns 400 — no retry).
 */
export const makeVerify =
  (
    config: TelegramConfig,
    client: TelegramClient
  ): FusorVerify<TelegramPayload> =>
  (req: FusorVerifyRequest): TelegramPayload => {
    if (config.webhookSecret) {
      verifySecret(req.headers, config.webhookSecret);
    }
    const update = parseUpdate(new TextDecoder().decode(req.rawBody));
    return { client, update };
  };
