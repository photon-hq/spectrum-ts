import { envAwareConfig } from "@spectrum-ts/core/authoring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  configSchema as rawConfigSchema,
  TELEGRAM_PLATFORM,
} from "@/config";

// `definePlatform` applies the env fallback from the platform id; mirror that
// here so the test exercises the same `SPECTRUM_TELEGRAM_*` resolution.
const configSchema = envAwareConfig(TELEGRAM_PLATFORM, rawConfigSchema);

const BOT_TOKEN = "SPECTRUM_TELEGRAM_BOT_TOKEN";
const WEBHOOK_SECRET = "SPECTRUM_TELEGRAM_WEBHOOK_SECRET";
const BASE_URL = "SPECTRUM_TELEGRAM_BASE_URL";
const ENV_KEYS = [BOT_TOKEN, WEBHOOK_SECRET, BASE_URL];

const VALID_TOKEN = "123456:abcdef";

describe("telegram config env fallback", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("reads botToken from the env var", () => {
    process.env[BOT_TOKEN] = VALID_TOKEN;
    expect(configSchema.parse({}).botToken).toBe(VALID_TOKEN);
  });

  it("lets an explicit botToken win over the env var", () => {
    process.env[BOT_TOKEN] = "999999:fromenv";
    expect(configSchema.parse({ botToken: VALID_TOKEN }).botToken).toBe(
      VALID_TOKEN
    );
  });

  it("still validates the botToken shape when read from env", () => {
    process.env[BOT_TOKEN] = "not-a-valid-token";
    expect(() => configSchema.parse({})).toThrow();
  });

  it("throws when botToken is absent from both config and env", () => {
    expect(() => configSchema.parse({})).toThrow();
  });

  it("reads webhookSecret from the env var", () => {
    process.env[BOT_TOKEN] = VALID_TOKEN;
    process.env[WEBHOOK_SECRET] = "secret_token-1";
    expect(configSchema.parse({}).webhookSecret).toBe("secret_token-1");
  });

  it("applies explicit > env > default precedence for baseUrl", () => {
    process.env[BOT_TOKEN] = VALID_TOKEN;

    process.env[BASE_URL] = "https://env.telegram.example";
    expect(configSchema.parse({}).baseUrl).toBe("https://env.telegram.example");

    expect(
      configSchema.parse({ baseUrl: "https://explicit.telegram.example" })
        .baseUrl
    ).toBe("https://explicit.telegram.example");

    delete process.env[BASE_URL];
    expect(configSchema.parse({}).baseUrl).toBe(DEFAULT_BASE_URL);
  });
});
