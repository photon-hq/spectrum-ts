import { envAwareConfig } from "@spectrum-ts/core/authoring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isCloudConfig,
  isOutboundOnly,
  configSchema as rawConfigSchema,
} from "@/types";

// `definePlatform("whatsapp_business", ...)` applies the env fallback from the
// platform id; mirror that here so the test exercises the same
// `SPECTRUM_WHATSAPP_BUSINESS_*` resolution.
const configSchema = envAwareConfig("whatsapp_business", rawConfigSchema);

const ACCESS_TOKEN = "SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN";
const PHONE_NUMBER_ID = "SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID";
const APP_SECRET = "SPECTRUM_WHATSAPP_BUSINESS_APP_SECRET";
const ENV_KEYS = [ACCESS_TOKEN, PHONE_NUMBER_ID, APP_SECRET];

describe("whatsapp-business config", () => {
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

  describe("mode discrimination", () => {
    it("accepts inbound mode with all three credentials", () => {
      const config = configSchema.parse({
        mode: "inbound",
        accessToken: "t",
        phoneNumberId: "p",
        appSecret: "s",
      });
      expect(isCloudConfig(config)).toBe(false);
      expect(isOutboundOnly(config)).toBe(false);
      expect(config).toMatchObject({
        mode: "inbound",
        accessToken: "t",
        phoneNumberId: "p",
        appSecret: "s",
      });
    });

    it("accepts outbound-only mode without an appSecret", () => {
      const config = configSchema.parse({
        mode: "outbound-only",
        accessToken: "t",
        phoneNumberId: "p",
      });
      expect(isCloudConfig(config)).toBe(false);
      expect(isOutboundOnly(config)).toBe(true);
    });

    it("treats an empty config as cloud mode", () => {
      const config = configSchema.parse({});
      expect(isCloudConfig(config)).toBe(true);
      expect(isOutboundOnly(config)).toBe(false);
    });
  });

  describe("partial / ambiguous configs fail fast", () => {
    it("rejects inbound mode missing appSecret with a clear message", () => {
      expect(() =>
        configSchema.parse({
          mode: "inbound",
          accessToken: "t",
          phoneNumberId: "p",
        })
      ).toThrow("appSecret");
    });

    it("rejects credentials with no mode instead of inferring one", () => {
      // The old shape (accessToken + phoneNumberId, no mode) must not silently
      // resolve to a broken inbound mode — it matches no branch.
      expect(() =>
        configSchema.parse({ accessToken: "t", phoneNumberId: "p" })
      ).toThrow();
    });

    it("rejects an appSecret passed alongside outbound-only mode", () => {
      expect(() =>
        configSchema.parse({
          mode: "outbound-only",
          accessToken: "t",
          phoneNumberId: "p",
          appSecret: "s",
        })
      ).toThrow();
    });

    it("rejects inbound mode missing phoneNumberId", () => {
      expect(() =>
        configSchema.parse({
          mode: "inbound",
          accessToken: "t",
          appSecret: "s",
        })
      ).toThrow();
    });
  });

  describe("credential env fallback (mode stays explicit)", () => {
    it("fills inbound credentials from env when mode is given", () => {
      process.env[ACCESS_TOKEN] = "env-token";
      process.env[PHONE_NUMBER_ID] = "env-phone";
      process.env[APP_SECRET] = "env-secret";
      const config = configSchema.parse({ mode: "inbound" });
      expect(config).toMatchObject({
        mode: "inbound",
        accessToken: "env-token",
        phoneNumberId: "env-phone",
        appSecret: "env-secret",
      });
    });

    it("fills outbound-only credentials from env when mode is given", () => {
      process.env[ACCESS_TOKEN] = "env-token";
      process.env[PHONE_NUMBER_ID] = "env-phone";
      const config = configSchema.parse({ mode: "outbound-only" });
      expect(isOutboundOnly(config)).toBe(true);
      expect(config).toMatchObject({
        mode: "outbound-only",
        accessToken: "env-token",
        phoneNumberId: "env-phone",
      });
    });

    it("still requires appSecret for inbound even from env", () => {
      process.env[ACCESS_TOKEN] = "env-token";
      process.env[PHONE_NUMBER_ID] = "env-phone";
      // No APP_SECRET env → inbound must still fail fast.
      expect(() => configSchema.parse({ mode: "inbound" })).toThrow(
        "appSecret"
      );
    });

    it("does not flip an empty config into direct mode via env credentials", () => {
      process.env[ACCESS_TOKEN] = "env-token";
      process.env[PHONE_NUMBER_ID] = "env-phone";
      process.env[APP_SECRET] = "env-secret";
      // Without an explicit `mode`, env credentials never conjure a direct mode.
      expect(isCloudConfig(configSchema.parse({}))).toBe(true);
    });

    it("lets explicit credentials win over env", () => {
      process.env[ACCESS_TOKEN] = "env-token";
      process.env[PHONE_NUMBER_ID] = "env-phone";
      process.env[APP_SECRET] = "env-secret";
      const config = configSchema.parse({
        mode: "inbound",
        accessToken: "explicit",
        phoneNumberId: "explicit-p",
        appSecret: "explicit-s",
      });
      expect(config).toMatchObject({
        accessToken: "explicit",
        phoneNumberId: "explicit-p",
        appSecret: "explicit-s",
      });
    });
  });
});
