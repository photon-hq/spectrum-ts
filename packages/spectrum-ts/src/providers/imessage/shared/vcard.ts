import type { Content } from "../../../content/types";

const VCARD_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/vcard",
  "text/x-vcard",
  "text/directory",
  "application/vcard",
  "application/x-vcard",
]);

export const normalizeMimeType = (mimeType: string): string =>
  (mimeType.split(";")[0] ?? "").trim().toLowerCase();

export const isVCardAttachment = (
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): boolean => {
  if (mimeType && VCARD_MIME_TYPES.has(normalizeMimeType(mimeType))) {
    return true;
  }
  return Boolean(fileName?.toLowerCase().endsWith(".vcf"));
};

export const vcardFileName = (
  contact: Extract<Content, { type: "contact" }>
): string => {
  const base = contact.name?.formatted ?? contact.user?.id ?? "contact";
  return `${base.replace(/[^a-zA-Z0-9_\-.]/g, "_")}.vcf`;
};
