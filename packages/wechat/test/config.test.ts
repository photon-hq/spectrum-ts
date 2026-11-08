import { envAwareConfig } from "@spectrum-ts/core/authoring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_LOGIN_TIMEOUT_MS,
  configSchema as rawConfigSchema,
  WECHAT_PLATFORM,
} from "@/config";

// `definePlatform` applies the env fallback from the platform id; mirror that
// here so the test exercises the same `SPECTRUM_WECHAT_*` resolution.
const configSchema = envAwareConfig(WECHAT_PLATFORM, rawConfigSchema);

const BOT_TOKEN = "SPECTRUM_WECHAT_BOT_TOKEN";
const BASE_URL = "SPECTRUM_WECHAT_BASE_URL";
const STATE_FILE = "SPECTRUM_WECHAT_STATE_FILE";
const ENV_KEYS = [BOT_TOKEN, BASE_URL, STATE_FILE];

describe("wechat config", () => {
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

  it("needs nothing: no token means QR login at startup", () => {
    expect(configSchema.parse({})).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      login: { timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS },
    });
  });

  it("reads the token, base URL and state file from env vars", () => {
    process.env[BOT_TOKEN] = "env-token";
    process.env[BASE_URL] = "https://other.ilink.test";
    process.env[STATE_FILE] = "/tmp/wechat.json";

    expect(configSchema.parse({})).toMatchObject({
      botToken: "env-token",
      baseUrl: "https://other.ilink.test",
      stateFile: "/tmp/wechat.json",
    });
  });

  it("lets explicit config win over env vars", () => {
    process.env[BOT_TOKEN] = "env-token";

    expect(configSchema.parse({ botToken: "explicit" }).botToken).toBe(
      "explicit"
    );
  });

  it("accepts login hooks and rejects non-functions", () => {
    const onQrCode = (_url: string) => undefined;

    expect(configSchema.parse({ login: { onQrCode } }).login.onQrCode).toBe(
      onQrCode
    );
    expect(() =>
      configSchema.parse({ login: { onQrCode: "print it" } })
    ).toThrow();
  });

  it("rejects an invalid base URL", () => {
    expect(() => configSchema.parse({ baseUrl: "not a url" })).toThrow();
  });
});
