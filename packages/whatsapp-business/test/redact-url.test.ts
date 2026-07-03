import { describe, expect, it } from "vitest";
import { redactMediaUrl } from "@/messages";

describe("redactMediaUrl", () => {
  it("drops the signed query string from a media URL", () => {
    const url =
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=ABC&hash=SECRET_SIG";
    expect(redactMediaUrl(url)).toBe(
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/"
    );
  });

  it("never leaves signing material in the redacted URL", () => {
    const redacted = redactMediaUrl(
      "https://cdn.example/media/x?token=topsecret&exp=123"
    );
    expect(redacted).not.toContain("topsecret");
    expect(redacted).not.toContain("token");
  });

  it("returns unparseable input unchanged", () => {
    expect(redactMediaUrl("not a url")).toBe("not a url");
  });
});
