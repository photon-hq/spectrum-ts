import { afterEach, beforeEach, describe, expect, it } from "vitest";
import z from "zod";
import {
  envAwareConfig,
  envFor,
  fromEnv,
  normalizePlatformName,
  toEnvKey,
} from "@/utils/env";

const ENV_KEY = "SPECTRUM_TEST_FROM_ENV";

describe("envFor", () => {
  it("joins the channel and key under the SPECTRUM_ prefix", () => {
    expect(envFor("TELEGRAM", "BOT_TOKEN")).toBe("SPECTRUM_TELEGRAM_BOT_TOKEN");
  });

  it("keeps multi-segment channels intact", () => {
    expect(envFor("WHATSAPP_BUSINESS", "ACCESS_TOKEN")).toBe(
      "SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN"
    );
  });
});

describe("fromEnv", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  it("uses the explicit value even when the env var is set", () => {
    process.env[ENV_KEY] = "from-env";
    const schema = fromEnv(ENV_KEY, z.string().min(1));
    expect(schema.parse("explicit")).toBe("explicit");
  });

  it("falls back to the env var when the field is undefined", () => {
    process.env[ENV_KEY] = "from-env";
    const schema = fromEnv(ENV_KEY, z.string().min(1));
    expect(schema.parse(undefined)).toBe("from-env");
  });

  it("treats an empty-string env var as unset", () => {
    process.env[ENV_KEY] = "";
    const schema = fromEnv(ENV_KEY, z.string().min(1));
    expect(() => schema.parse(undefined)).toThrow();
  });

  it("raises the inner schema's required error when both are absent", () => {
    const schema = fromEnv(ENV_KEY, z.string().min(1));
    expect(() => schema.parse(undefined)).toThrow();
  });

  it("preserves the inner schema's validation on the env value", () => {
    process.env[ENV_KEY] = "not-a-url";
    const schema = fromEnv(ENV_KEY, z.url());
    expect(() => schema.parse(undefined)).toThrow();
  });

  it("passes an env value that satisfies the inner schema", () => {
    process.env[ENV_KEY] = "https://example.com";
    const schema = fromEnv(ENV_KEY, z.url());
    expect(schema.parse(undefined)).toBe("https://example.com");
  });

  it("applies the inner schema's default when field and env are absent", () => {
    const schema = fromEnv(ENV_KEY, z.string().default("fallback"));
    expect(schema.parse(undefined)).toBe("fallback");
  });

  it("lets the env var win over the inner schema's default", () => {
    process.env[ENV_KEY] = "from-env";
    const schema = fromEnv(ENV_KEY, z.string().default("fallback"));
    expect(schema.parse(undefined)).toBe("from-env");
  });

  it("allows an optional field to resolve to undefined", () => {
    const schema = fromEnv(ENV_KEY, z.string().optional());
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("keeps a wrapped field as a plain key on a parsed object", () => {
    process.env[ENV_KEY] = "token";
    const schema = z.object({
      accessToken: fromEnv(ENV_KEY, z.string().min(1)),
    });
    const parsed = schema.parse({});
    expect("accessToken" in parsed).toBe(true);
    expect(parsed.accessToken).toBe("token");
  });
});

describe("normalizePlatformName", () => {
  it("upper-cases a simple id", () => {
    expect(normalizePlatformName("telegram")).toBe("TELEGRAM");
  });

  it("collapses spaces and punctuation to single underscores", () => {
    expect(normalizePlatformName("WhatsApp Business")).toBe(
      "WHATSAPP_BUSINESS"
    );
  });

  it("does not split internal camelCase", () => {
    expect(normalizePlatformName("iMessage")).toBe("IMESSAGE");
  });

  it("trims leading and trailing separators", () => {
    expect(normalizePlatformName(" Slack! ")).toBe("SLACK");
  });
});

describe("toEnvKey", () => {
  it("upper-snakes a camelCase field", () => {
    expect(toEnvKey("botToken")).toBe("BOT_TOKEN");
  });

  it("splits multiple camelCase boundaries", () => {
    expect(toEnvKey("phoneNumberId")).toBe("PHONE_NUMBER_ID");
  });

  it("splits a digit-to-upper boundary", () => {
    expect(toEnvKey("baseUrl")).toBe("BASE_URL");
  });
});

describe("envAwareConfig", () => {
  const ENV_KEYS = [
    "SPECTRUM_TELEGRAM_BOT_TOKEN",
    "SPECTRUM_TELEGRAM_BASE_URL",
    "SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN",
    "SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID",
    "SPECTRUM_DEMO_TOKENS",
    "SPECTRUM_DEMO_ITEMS",
    "SPECTRUM_DEMO_ENABLED",
  ];
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

  it("backs a string field from SPECTRUM_<PLATFORM>_<KEY>", () => {
    const schema = envAwareConfig(
      "telegram",
      z.object({ botToken: z.string() })
    );
    process.env.SPECTRUM_TELEGRAM_BOT_TOKEN = "123:abc";
    expect(schema.parse({}).botToken).toBe("123:abc");
  });

  it("lets an explicit value win over the env var", () => {
    const schema = envAwareConfig(
      "telegram",
      z.object({ botToken: z.string() })
    );
    process.env.SPECTRUM_TELEGRAM_BOT_TOKEN = "999:env";
    expect(schema.parse({ botToken: "explicit" }).botToken).toBe("explicit");
  });

  it("preserves an inner default over env precedence", () => {
    const schema = envAwareConfig(
      "telegram",
      z.object({ baseUrl: z.url().default("https://api.telegram.org") })
    );
    expect(schema.parse({}).baseUrl).toBe("https://api.telegram.org");
    process.env.SPECTRUM_TELEGRAM_BASE_URL = "https://env.example";
    expect(schema.parse({}).baseUrl).toBe("https://env.example");
  });

  it("treats an empty-string env var as unset", () => {
    const schema = envAwareConfig(
      "telegram",
      z.object({ botToken: z.string() })
    );
    process.env.SPECTRUM_TELEGRAM_BOT_TOKEN = "";
    expect(() => schema.parse({})).toThrow();
  });

  it("leaves non-string fields (records, arrays, booleans) untouched", () => {
    const schema = envAwareConfig(
      "demo",
      z.object({
        tokens: z.record(z.string(), z.string()),
        items: z.array(z.string()),
        enabled: z.boolean(),
      })
    );
    // An env var named after a non-string field is ignored — the field is still
    // required from config.
    process.env.SPECTRUM_DEMO_TOKENS = "ignored";
    process.env.SPECTRUM_DEMO_ITEMS = "ignored";
    process.env.SPECTRUM_DEMO_ENABLED = "true";
    const parsed = schema.parse({
      tokens: { t: "x" },
      items: ["a"],
      enabled: false,
    });
    expect(parsed).toEqual({
      tokens: { t: "x" },
      items: ["a"],
      enabled: false,
    });
  });

  it("resolves each union branch independently and preserves a strict branch", () => {
    const schema = envAwareConfig(
      "WhatsApp Business",
      z.union([
        z.object({
          accessToken: z.string().min(1),
          phoneNumberId: z.string().min(1),
        }),
        z.object({}).strict(),
      ])
    );

    // A complete env set satisfies the direct branch.
    process.env.SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN = "tok";
    process.env.SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID = "pid";
    expect(schema.parse({})).toMatchObject({
      accessToken: "tok",
      phoneNumberId: "pid",
    });

    // With no env, the strict empty branch still accepts an empty object.
    delete process.env.SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN;
    delete process.env.SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID;
    expect(schema.parse({})).toEqual({});
  });
});
