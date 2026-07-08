import { afterEach, beforeEach, describe, expect, it } from "vitest";
import z from "zod";
import { envFor, fromEnv } from "@/utils/env";

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
