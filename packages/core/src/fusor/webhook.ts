import z from "zod";
import type { ParsedHttpRequest } from "./parse";

export const FUSOR_DELIVERY_CE_TYPE = "dev.spctrm.fusor.delivery";

const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const canonicalBase64Schema = z.string().refine((value) => {
  if (!CANONICAL_BASE64.test(value)) {
    return false;
  }
  try {
    const binary = atob(value);
    return btoa(binary) === value;
  } catch {
    return false;
  }
}, "expected canonical padded base64");

const requestFields = {
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  rawBodyBase64: canonicalBase64Schema,
};

const fusorWebhookRequestSchema = z.discriminatedUnion("bodyEncoding", [
  z.looseObject({
    ...requestFields,
    bodyEncoding: z.literal("json"),
    body: z.json(),
  }),
  z.looseObject({
    ...requestFields,
    bodyEncoding: z.literal("form"),
    body: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  z.looseObject({
    ...requestFields,
    bodyEncoding: z.literal("text"),
    body: z.string(),
  }),
  z.looseObject({
    ...requestFields,
    bodyEncoding: z.literal("base64"),
    body: canonicalBase64Schema,
  }),
]);

const fusorWebhookEnvelopeSchema = z
  .looseObject({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1),
    projectId: z.string().min(1),
    platform: z.string().min(1),
    receivedAt: z.iso.datetime({ offset: true }).optional(),
    sourceId: z.string().min(1).optional(),
    prevSubjectSeq: z.number().int().nonnegative().safe(),
    request: fusorWebhookRequestSchema,
  })
  .superRefine((envelope, context) => {
    if (
      envelope.request.bodyEncoding === "base64" &&
      envelope.request.body !== envelope.request.rawBodyBase64
    ) {
      context.addIssue({
        code: "custom",
        path: ["request", "body"],
        message: "base64 body must equal rawBodyBase64",
      });
    }
  });

export interface FusorWebhookEvent {
  eventId: string;
  platform: string;
  request: ParsedHttpRequest;
}

const decodeCanonicalBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const normalizeHeaders = (
  input: Record<string, string>
): Record<string, string> => {
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of Object.entries(input)) {
    const lowerName = name.toLowerCase();
    headers[lowerName] = Object.hasOwn(headers, lowerName)
      ? `${headers[lowerName]}, ${value}`
      : value;
  }
  return headers;
};

/**
 * Parses the versioned JSON envelope delivered by Fusor over HTTP. The
 * normalized `body` arm is validation/debugging data; provider verification
 * always receives the exact original bytes from `rawBodyBase64`.
 */
export const decodeFusorWebhookEvent = (
  bodyBytes: Uint8Array
): FusorWebhookEvent | null => {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    const envelope = fusorWebhookEnvelopeSchema.parse(JSON.parse(json));
    return {
      eventId: envelope.eventId,
      platform: envelope.platform,
      request: {
        method: envelope.request.method,
        path: envelope.request.path,
        headers: normalizeHeaders(envelope.request.headers),
        rawBody: decodeCanonicalBase64(envelope.request.rawBodyBase64),
      },
    };
  } catch {
    return null;
  }
};
