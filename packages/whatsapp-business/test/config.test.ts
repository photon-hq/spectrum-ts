import { envAwareConfig } from "@spectrum-ts/core/authoring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCloudConfig, configSchema as rawConfigSchema } from "@/types";

// `definePlatform("whatsapp_business", ...)` applies the env fallback from the
// platform id; mirror that here so the test exercises the same
// `SPECTRUM_WHATSAPP_BUSINESS_*` resolution.
const configSchema = envAwareConfig("whatsapp_business", rawConfigSchema);

const ACCESS_TOKEN = "SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN";
const PHONE_NUMBER_ID = "SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID";
const APP_SECRET = "SPECTRUM_WHATSAPP_BUSINESS_APP_SECRET";
const ENV_KEYS = [ACCESS_TOKEN, PHONE_NUMBER_ID, APP_SECRET];

describe("whatsapp-business config env fallback", () => {
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

  it("enables direct mode from a complete env credential set", () => {
    process.env[ACCESS_TOKEN] = "env-token";
    process.env[PHONE_NUMBER_ID] = "env-phone";
    const config = configSchema.parse({});
    expect(isCloudConfig(config)).toBe(false);
    expect(config).toMatchObject({
      accessToken: "env-token",
      phoneNumberId: "env-phone",
    });
  });

  it("falls back to cloud mode when the env set is partial", () => {
    process.env[ACCESS_TOKEN] = "env-token";
    const config = configSchema.parse({});
    expect(isCloudConfig(config)).toBe(true);
  });

  it("lets explicit config override env credentials", () => {
    process.env[ACCESS_TOKEN] = "env-token";
    process.env[PHONE_NUMBER_ID] = "env-phone";
    const config = configSchema.parse({
      accessToken: "explicit-token",
      phoneNumberId: "explicit-phone",
    });
    expect(config).toMatchObject({
      accessToken: "explicit-token",
      phoneNumberId: "explicit-phone",
    });
  });

  it("stays cloud mode with no explicit config and no env vars", () => {
    const config = configSchema.parse({});
    expect(isCloudConfig(config)).toBe(true);
  });

  it("mixes an explicit access token with an env phone number id", () => {
    process.env[PHONE_NUMBER_ID] = "env-phone";
    const config = configSchema.parse({ accessToken: "explicit-token" });
    expect(isCloudConfig(config)).toBe(false);
    expect(config).toMatchObject({
      accessToken: "explicit-token",
      phoneNumberId: "env-phone",
    });
  });
});
