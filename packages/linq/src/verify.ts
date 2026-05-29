import { createHmac, timingSafeEqual } from "node:crypto";
import type { FusorVerify, FusorVerifyRequest } from "spectrum-ts";
import type { LinqConfig } from "./config";
import type { LinqPayload } from "./types";

const TIMESTAMP_HEADER = "x-webhook-timestamp";
const SIGNATURE_HEADER = "x-webhook-signature";
const MILLIS_PER_SECOND = 1000;

const assertFresh = (timestamp: string, toleranceSec: number): void => {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new Error("LinQ webhook timestamp is not numeric");
  }
  const nowSec = Date.now() / MILLIS_PER_SECOND;
  if (Math.abs(nowSec - ts) > toleranceSec) {
    throw new Error(
      "LinQ webhook timestamp outside tolerance (possible replay)"
    );
  }
};

const safeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

const verifySignature = (
  headers: Record<string, string>,
  bodyText: string,
  secret: string,
  toleranceSec: number
): void => {
  const timestamp = headers[TIMESTAMP_HEADER];
  const signature = headers[SIGNATURE_HEADER];
  if (!(timestamp && signature)) {
    throw new Error("LinQ webhook is missing signature headers");
  }
  assertFresh(timestamp, toleranceSec);
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${bodyText}`)
    .digest("hex");
  if (!safeEqualHex(expected, signature)) {
    throw new Error("LinQ webhook signature mismatch");
  }
};

const isEnvelope = (value: unknown): value is { event_type: string } =>
  typeof value === "object" &&
  value !== null &&
  "event_type" in value &&
  typeof (value as { event_type: unknown }).event_type === "string";

const parsePayload = (bodyText: string): LinqPayload => {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("LinQ webhook body is not valid JSON");
  }
  if (!isEnvelope(json)) {
    throw new Error("LinQ webhook payload is missing event_type");
  }
  return json as LinqPayload;
};

/**
 * Build the Fusor `verify` hook. Closes over `config` so it can check the LinQ
 * HMAC (`HMAC-SHA256` over `"{timestamp}.{rawBody}"`) and replay-guard the
 * signed timestamp. When no signing secret is configured the signature check
 * is skipped and the body is parsed directly. Throwing rejects the event
 * (Fusor returns 400 — poison, no retry).
 */
export const makeVerify =
  (config: LinqConfig): FusorVerify<LinqPayload> =>
  (req: FusorVerifyRequest): LinqPayload => {
    const bodyText = new TextDecoder().decode(req.rawBody);
    if (config.webhookSigningSecret) {
      verifySignature(
        req.headers,
        bodyText,
        config.webhookSigningSecret,
        config.replayToleranceSec
      );
    }
    return parsePayload(bodyText);
  };
