import type { FusorVerify, FusorVerifyRequest } from "../../fusor/types";
import type { XCloudAuth } from "./auth";
import type { XDirectConfig } from "./config";
import { verifySignature } from "./signature";
import type { XPayload } from "./types";

/** HMAC-SHA256 signature header X sends on POST webhook deliveries. */
const SIGNATURE_HEADER = "x-twitter-webhooks-signature";

const decodeBody = (rawBody: Uint8Array): string =>
  new TextDecoder().decode(rawBody);

const parseBody = (rawBody: Uint8Array): unknown => {
  try {
    return JSON.parse(decodeBody(rawBody));
  } catch {
    throw new Error("X webhook body is not valid JSON");
  }
};

const parseCrcToken = (path: string): string => {
  const url = new URL(path, "https://fusor.local");
  const token = url.searchParams.get("crc_token");
  if (!token) {
    throw new Error("X webhook CRC request is missing crc_token");
  }
  return token;
};

const verifyWithConsumerSecret =
  (consumerSecret: string): FusorVerify<XPayload> =>
  (req: FusorVerifyRequest): XPayload => {
    if (req.method === "GET") {
      return { type: "crc", crcToken: parseCrcToken(req.path) };
    }

    if (req.method !== "POST") {
      throw new Error(`X webhook does not support method ${req.method}`);
    }

    const signatureHeader = req.headers[SIGNATURE_HEADER];
    if (!signatureHeader) {
      throw new Error("X webhook is missing x-twitter-webhooks-signature");
    }
    if (!verifySignature(req.rawBody, signatureHeader, consumerSecret)) {
      throw new Error("X webhook signature mismatch");
    }

    return { type: "dm", body: parseBody(req.rawBody) };
  };

/**
 * Build the Fusor `verify` hook for direct mode. Closes over
 * `config.consumerSecret` only — no client is involved.
 */
export const verify =
  (config: XDirectConfig): FusorVerify<XPayload> =>
  (req: FusorVerifyRequest) =>
    verifyWithConsumerSecret(config.consumerSecret)(req);

/**
 * Build the Fusor `verify` hook for cloud mode. Resolves `consumerSecret` from
 * the cloud auth sidecar on each request.
 */
export const makeVerify =
  (auth: XCloudAuth, consumerSecretOverride?: string): FusorVerify<XPayload> =>
  async (req: FusorVerifyRequest): Promise<XPayload> => {
    const consumerSecret =
      consumerSecretOverride ?? (await auth.getConsumerSecret());
    return verifyWithConsumerSecret(consumerSecret)(req);
  };
