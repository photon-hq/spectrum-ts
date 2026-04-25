import { describe, expect, test } from "bun:test";
import type { Content } from "../../../content/types";
import { isVCardAttachment, vcardFileName } from "./vcard";

describe("iMessage vCard helpers", () => {
  test("detects vCard attachments by MIME type and filename", () => {
    expect(isVCardAttachment("text/vcard", "contact.txt")).toBe(true);
    expect(isVCardAttachment("TEXT/VCARD; charset=utf-8", undefined)).toBe(
      true
    );
    expect(isVCardAttachment("application/x-vcard", "contact.bin")).toBe(true);
    expect(isVCardAttachment("text/plain", "contact.vcf")).toBe(true);
    expect(isVCardAttachment("text/plain", "contact.txt")).toBe(false);
    expect(isVCardAttachment(undefined, undefined)).toBe(false);
  });

  test("sanitizes contact filenames", () => {
    const contact = {
      type: "contact",
      name: { formatted: "Ada / Lovelace?" },
    } as Extract<Content, { type: "contact" }>;

    expect(vcardFileName(contact)).toBe("Ada___Lovelace_.vcf");
  });
});
