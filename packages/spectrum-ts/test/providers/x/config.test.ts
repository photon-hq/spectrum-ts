import { describe, expect, it } from "bun:test";
import { directConfigSchema, hasRefreshCreds } from "@/providers/x/config";

const base = {
  consumerSecret: "cs",
  accessToken: "at",
  xUserId: "42",
  appBearerToken: "bt",
};

describe("x directConfigSchema refresh creds", () => {
  it("accepts static config with no refresh creds", () => {
    expect(directConfigSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a full refresh cred set", () => {
    const result = directConfigSchema.safeParse({
      ...base,
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a partial refresh cred set", () => {
    const result = directConfigSchema.safeParse({ ...base, clientId: "c" });
    expect(result.success).toBe(false);
  });

  it("hasRefreshCreds reflects whether the full set is present", () => {
    const withCreds = directConfigSchema.parse({
      ...base,
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
    });
    const staticOnly = directConfigSchema.parse(base);
    expect(hasRefreshCreds(withCreds)).toBe(true);
    expect(hasRefreshCreds(staticOnly)).toBe(false);
  });
});
