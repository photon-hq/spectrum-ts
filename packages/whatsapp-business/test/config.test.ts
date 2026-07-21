import { envAwareConfig } from "@spectrum-ts/core/authoring";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import z from "zod";
import type { whatsappBusiness } from "@/index";
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
const APP_SECRET_REQUIRED =
  "WhatsApp Business `mode: 'inbound'` requires `appSecret` (it verifies inbound webhook signatures). Provide it, or use `mode: 'outbound-only'` for send-only.";

describe("whatsapp-business config", () => {
  const saved = new Map<string, string | undefined>();

  it("requires a direct mode in the public config input type", () => {
    type ConfigInput = NonNullable<
      Parameters<typeof whatsappBusiness.config>[0]
    >;
    interface LegacyFlatDirect {
      accessToken: string;
      appSecret: string;
      phoneNumberId: string;
    }
    interface OutboundWithSecret {
      appSecret: string;
      mode: "outbound-only";
    }

    expectTypeOf<{ mode: "inbound" }>().toMatchTypeOf<ConfigInput>();
    expectTypeOf<{ mode: "outbound-only" }>().toMatchTypeOf<ConfigInput>();
    expectTypeOf<LegacyFlatDirect>().not.toMatchTypeOf<ConfigInput>();
    expectTypeOf<OutboundWithSecret>().not.toMatchTypeOf<ConfigInput>();
  });

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
      const result = configSchema.safeParse({
        mode: "inbound",
        accessToken: "t",
        phoneNumberId: "p",
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected inbound config without appSecret to fail");
      }
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({
        path: ["appSecret"],
        message: APP_SECRET_REQUIRED,
      });
      expect(z.prettifyError(result.error)).toContain(APP_SECRET_REQUIRED);
    });

    it("rejects an empty inbound appSecret with the same clear message", () => {
      const result = configSchema.safeParse({
        mode: "inbound",
        accessToken: "t",
        phoneNumberId: "p",
        appSecret: "",
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected inbound config with empty appSecret to fail");
      }
      expect(result.error.issues[0]).toMatchObject({
        path: ["appSecret"],
        message: APP_SECRET_REQUIRED,
      });
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
