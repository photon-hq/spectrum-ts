import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("AI SDK adapter browser safety", () => {
  test("does not import runtime provider modules", () => {
    const source = readFileSync(
      new URL("../index.ts", import.meta.url),
      "utf8"
    );

    expect(source).not.toContain("node:");
    expect(source).not.toContain("providers/");
    expect(source).not.toContain("imessage");
    expect(source).not.toContain("whatsapp");
    expect(source).not.toContain("web-chat");
    expect(source).not.toContain("web-bridge");
  });
});
