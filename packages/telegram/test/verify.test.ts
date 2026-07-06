import { describe, expect, it } from "vitest";
import { configSchema } from "@/config";
import type { TelegramPayload } from "@/types";
import { verify } from "@/verify";

const SECRET = "s3cr3t_token-123";

const body = (updateId = 1): string =>
  JSON.stringify({
    update_id: updateId,
    message: {
      message_id: 5,
      date: 1_700_000_000,
      chat: { id: 100, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Alice" },
      text: "hi",
    },
  });

const request = (payload: string, headers: Record<string, string>) => ({
  headers,
  method: "POST",
  path: "/telegram",
  rawBody: new TextEncoder().encode(payload),
});

const verifyWith = (secret?: string) =>
  verify(
    configSchema.parse({
      botToken: "42:abc",
      ...(secret ? { webhookSecret: secret } : {}),
    })
  );

describe("verify", () => {
  it("accepts when the secret token header matches and returns the parsed update", () => {
    const update = verifyWith(SECRET)(
      request(body(), { "x-telegram-bot-api-secret-token": SECRET })
    ) as TelegramPayload;
    expect(update.update_id).toBe(1);
    expect(update.message?.text).toBe("hi");
  });

  it("rejects a mismatched secret token", () => {
    expect(() =>
      verifyWith(SECRET)(
        request(body(), { "x-telegram-bot-api-secret-token": "wrong" })
      )
    ).toThrow("mismatch");
  });

  it("rejects a missing secret token header when a secret is configured", () => {
    expect(() => verifyWith(SECRET)(request(body(), {}))).toThrow(
      "missing the secret token"
    );
  });

  it("skips verification when no secret is configured", () => {
    const update = verifyWith()(request(body(), {})) as TelegramPayload;
    expect(update.update_id).toBe(1);
  });

  it("rejects a body that is not valid JSON", () => {
    expect(() => verifyWith()(request("not json", {}))).toThrow(
      "not valid JSON"
    );
  });

  it("rejects a payload missing update_id", () => {
    expect(() =>
      verifyWith()(request(JSON.stringify({ message: {} }), {}))
    ).toThrow("update_id");
  });

  it("rejects a payload with a non-numeric update_id", () => {
    expect(() =>
      verifyWith()(request(JSON.stringify({ update_id: "1" }), {}))
    ).toThrow("update_id");
  });
});
