import { describe, expect, it } from "bun:test";
import { redactBotToken } from "@/client";

describe("redactBotToken", () => {
  it("masks the bot token in a Telegram file URL path", () => {
    const url =
      "https://api.telegram.org/file/bot123456:AAH-secret_token/photos/file_1.jpg";
    expect(redactBotToken(url)).toBe(
      "https://api.telegram.org/file/bot<redacted>/photos/file_1.jpg"
    );
  });

  it("never leaves the token in the redacted URL, for any base", () => {
    const url =
      "https://custom.example/file/bot987654:ZZ_top-secret/voice/v.ogg";
    expect(redactBotToken(url)).not.toContain("987654:ZZ_top-secret");
  });
});
