import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import z from "zod";

const MILLIS_PER_SECOND = 1000;
const REPLAY_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";
const SIGNATURE_PREFIX = "v1,";
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SIGNATURE_SEPARATOR = /\s+/;
const UNSIGNED_INTEGER = /^\d+$/;

export type WebhookJsonValue =
  | null
  | boolean
  | number
  | string
  | WebhookJsonValue[]
  | { [key: string]: WebhookJsonValue };

export interface MessageReceivedWebhookRequest {
  body: WebhookJsonValue | Record<string, string | string[]> | string;
  bodyEncoding: "json" | "form" | "text" | "base64";
  headers: Record<string, string>;
  method: string;
  path: string;
  rawBodyBase64: string;
}

/** The Standard Webhooks payload emitted for a project inbound event. */
export interface MessageReceivedWebhook {
  eventId: string;
  platform: string;
  prevSubjectSeq: number;
  projectId: string;
  receivedAt?: string;
  request: MessageReceivedWebhookRequest;
  schemaVersion: 1;
  sourceId?: string;
  timestamp?: string;
  type: "message.received";
}

export type StandardWebhookEvent = MessageReceivedWebhook;

export type StandardWebhookHeaders =
  | Headers
  | Record<string, string | readonly string[] | undefined>;

export interface VerifyStandardWebhookInput {
  /** Request headers. Names are matched case-insensitively. */
  headers: StandardWebhookHeaders;
  /** Epoch milliseconds; injectable for deterministic tests. */
  now?: number;
  /** The exact body bytes received on the wire. */
  rawBody: Uint8Array;
  /** The complete `whsec_` secret returned at registration or rotation. */
  secret: string;
  /** Allowed signing-time skew in seconds. Defaults to five minutes. */
  toleranceSeconds?: number;
}

export type VerifyStandardWebhookResult =
  | { messageId: string; ok: true; timestamp: number }
  | {
      ok: false;
      reason:
        | "missing-headers"
        | "invalid-headers"
        | "expired"
        | "invalid-secret"
        | "signature-mismatch";
    };

const readHeader = (
  headers: StandardWebhookHeaders,
  name: string
): string | undefined => {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) {
      continue;
    }
    return Array.isArray(value) ? value.join(" ") : value;
  }
  return;
};

const decodeCanonicalBase64 = (value: string): Buffer | undefined => {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value ? decoded : undefined;
  } catch {
    return;
  }
};

const decodeSecret = (secret: string): Buffer | undefined => {
  const serialized = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const decoded = decodeCanonicalBase64(serialized);
  if (!decoded || decoded.byteLength < 24 || decoded.byteLength > 64) {
    return;
  }
  return decoded;
};

const signatureBytes = (header: string): Buffer[] => {
  const signatures: Buffer[] = [];
  for (const token of header.trim().split(SIGNATURE_SEPARATOR)) {
    if (!token.startsWith(SIGNATURE_PREFIX)) {
      continue;
    }
    const decoded = decodeCanonicalBase64(token.slice(SIGNATURE_PREFIX.length));
    if (decoded?.byteLength === 32) {
      signatures.push(decoded);
    }
  }
  return signatures;
};

/**
 * Verify a Standard Webhooks v1 signature over the exact request bytes.
 * Multiple space-delimited signatures are accepted for zero-downtime secret
 * rotation. The `whsec_` prefix is removed before the Base64 key is decoded.
 */
export function verifyStandardWebhookSignature(
  input: VerifyStandardWebhookInput
): VerifyStandardWebhookResult {
  const messageId = readHeader(input.headers, "webhook-id")?.trim();
  const timestampHeader = readHeader(
    input.headers,
    "webhook-timestamp"
  )?.trim();
  const signatureHeader = readHeader(
    input.headers,
    "webhook-signature"
  )?.trim();
  if (!(messageId && timestampHeader && signatureHeader)) {
    return { ok: false, reason: "missing-headers" };
  }
  if (messageId.includes(".") || !UNSIGNED_INTEGER.test(timestampHeader)) {
    return { ok: false, reason: "invalid-headers" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: "invalid-headers" };
  }
  const toleranceSeconds = input.toleranceSeconds ?? REPLAY_TOLERANCE_SECONDS;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    return { ok: false, reason: "invalid-headers" };
  }
  const nowSeconds = Math.floor((input.now ?? Date.now()) / MILLIS_PER_SECOND);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "expired" };
  }

  const secret = decodeSecret(input.secret);
  if (!secret) {
    return { ok: false, reason: "invalid-secret" };
  }
  const providedSignatures = signatureBytes(signatureHeader);
  if (providedSignatures.length === 0) {
    return { ok: false, reason: "invalid-headers" };
  }

  const base = Buffer.concat([
    Buffer.from(`${messageId}.${timestampHeader}.`, "utf8"),
    Buffer.from(input.rawBody),
  ]);
  const expected = createHmac("sha256", secret).update(base).digest();
  let matched = false;
  for (const provided of providedSignatures) {
    matched = timingSafeEqual(provided, expected) || matched;
  }
  return matched
    ? { messageId, ok: true, timestamp }
    : { ok: false, reason: "signature-mismatch" };
}

const safeTimestamp = z.iso.datetime({ offset: true });
const safeHeaderName = z.string().regex(HTTP_TOKEN);

const hasInvalidHeaderValueCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) {
      return true;
    }
  }
  return false;
};

const hasRequestPathControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) {
      return true;
    }
  }
  return false;
};

const safeHeaderValue = z
  .string()
  .refine(
    (value) => !hasInvalidHeaderValueCharacter(value),
    "Header value contains a control character"
  );
const safePath = z
  .string()
  .min(1)
  .refine(
    (value) => !hasRequestPathControlCharacter(value),
    "Request path contains a control character"
  );
const canonicalBase64 = z
  .string()
  .refine(
    (value) => decodeCanonicalBase64(value) !== undefined,
    "Expected canonical Base64"
  );

const messageReceivedWebhookSchema = z.looseObject({
  eventId: z
    .string()
    .min(1)
    .refine((value) => !value.includes(".")),
  platform: z.string().min(1),
  prevSubjectSeq: z
    .number()
    .int()
    .nonnegative()
    .refine(Number.isSafeInteger, "Expected a safe integer"),
  projectId: z.string().min(1),
  receivedAt: safeTimestamp.optional(),
  request: z.looseObject({
    body: z.unknown(),
    bodyEncoding: z.enum(["json", "form", "text", "base64"]),
    headers: z.record(safeHeaderName, safeHeaderValue),
    method: z.string().regex(HTTP_TOKEN),
    path: safePath,
    rawBodyBase64: canonicalBase64,
  }),
  schemaVersion: z.literal(1),
  sourceId: z.string().optional(),
  timestamp: safeTimestamp.optional(),
  type: z.literal("message.received"),
});

/** Parse and validate a signed Standard Webhooks payload after verification. */
export function parseStandardWebhookEvent(
  rawBody: Uint8Array
): StandardWebhookEvent {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  return messageReceivedWebhookSchema.parse(
    JSON.parse(text)
  ) as StandardWebhookEvent;
}

const encodeRawRequest = (
  request: MessageReceivedWebhookRequest
): Uint8Array => {
  const lines = [`${request.method} ${request.path} HTTP/1.1`];
  for (const [name, value] of Object.entries(request.headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return Buffer.concat([
    Buffer.from(lines.join("\r\n"), "utf8"),
    Buffer.from(request.rawBodyBase64, "base64"),
  ]);
};

/** @internal Reconstruct the Fusor event consumed by provider handlers. */
export function standardWebhookToRawInboundEvent(
  event: StandardWebhookEvent
): RawInboundEvent {
  return {
    eventId: event.eventId,
    platform: event.platform,
    prevSubjectSeq: event.prevSubjectSeq,
    projectId: event.projectId,
    rawRequest: encodeRawRequest(event.request),
    receivedAt: event.receivedAt ? new Date(event.receivedAt) : undefined,
    sourceId: event.sourceId ?? "",
  };
}
