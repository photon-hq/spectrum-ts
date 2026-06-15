import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

const secureCompare = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length === 0 || leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
};

/**
 * We need to build a signature for the webhook request. This is used to verify the request is coming from X. We use the consumer secret to sign the request.
 * This is to ensure that X also does not block our request.
 * @param rawBody - The raw body of the request.
 * @param consumerSecret - The consumer secret to use for the signature. This is the consumer secret of the project.
 * @returns The signature.
 */
export const buildSignature = (
  rawBody: Uint8Array,
  consumerSecret: string
): string => {
  const digest = createHmac("sha256", consumerSecret)
    .update(rawBody)
    .digest("base64");
  return `${SIGNATURE_PREFIX}${digest}`;
};

/**
 * Verify an X webhook signature header against the raw body. Expects the
 * `sha256=` prefix and compares digests with a timing-safe equality check.
 */
export const verifySignature = (
  rawBody: Uint8Array,
  signatureHeader: string,
  consumerSecret: string
): boolean => {
  if (!(consumerSecret && signatureHeader.startsWith(SIGNATURE_PREFIX))) {
    return false;
  }
  const expected = buildSignature(rawBody, consumerSecret);
  return secureCompare(expected, signatureHeader);
};
