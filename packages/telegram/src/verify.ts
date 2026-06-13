import { timingSafeEqual } from "node:crypto";
import type { FusorVerify, FusorVerifyRequest } from "@spectrum-ts/core";
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
 * Build the Fusor `verify` hook. Receiving is pure parsing: it closes over
 * `config` only to check the webhook secret token, then parses the raw body
 * into an `Update` and returns it as the payload — no client is involved. When
 * no `webhookSecret` is configured the token check is skipped and the body is
 * parsed directly. Throwing rejects the event (Fusor returns 400 — no retry).
 * The inbound mapper reads `config` from its own ctx and builds a client inline
 * only if it needs to download media.
 */
export const verify =
  (config: TelegramConfig): FusorVerify<TelegramPayload> =>
  (req: FusorVerifyRequest): TelegramPayload => {
    if (config.webhookSecret) {
      verifySecret(req.headers, config.webhookSecret);
    }
    return parseUpdate(new TextDecoder().decode(req.rawBody));
  };
