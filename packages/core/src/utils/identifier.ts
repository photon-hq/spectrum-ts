import { sanitizeEmail, sanitizePhone } from "@photon-ai/otel";

export type IdentifierKind = "phone" | "email" | "unknown";

const PHONE_LIKE = /^\+?[\d\s()\-.]{7,}$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function classifyIdentifier(s: string): {
  kind: IdentifierKind;
  identifier: string;
} {
  if (EMAIL_LIKE.test(s)) {
    return { kind: "email", identifier: sanitizeEmail(s) };
  }
  if (PHONE_LIKE.test(s) && s.replace(/\D/g, "").length >= 7) {
    return { kind: "phone", identifier: sanitizePhone(s) };
  }
  return { kind: "unknown", identifier: s };
}
