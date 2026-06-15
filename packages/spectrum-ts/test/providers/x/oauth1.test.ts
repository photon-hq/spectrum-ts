import { describe, expect, it } from "bun:test";
import { oauth1Header } from "@/providers/x/oauth1";

const creds = {
  accessToken: "760905414019-usercontexttoken",
  accessTokenSecret: "token-secret",
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
};

const URL =
  "https://api.x.com/2/account_activity/webhooks/abc/subscriptions/all";

describe("oauth1Header", () => {
  it("produces an OAuth 1.0a Authorization header with all required fields", () => {
    const header = oauth1Header("POST", URL, creds, {
      nonce: "fixednonce",
      timestamp: "1700000000",
    });

    expect(header.startsWith("OAuth ")).toBe(true);
    expect(header).toContain('oauth_consumer_key="consumer-key"');
    expect(header).toContain('oauth_token="760905414019-usercontexttoken"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_version="1.0"');
    expect(header).toContain('oauth_nonce="fixednonce"');
    expect(header).toContain('oauth_timestamp="1700000000"');
    expect(header).toContain("oauth_signature=");
  });

  it("is deterministic for fixed nonce + timestamp", () => {
    const opts = { nonce: "abc123", timestamp: "1700000000" };
    expect(oauth1Header("POST", URL, creds, opts)).toBe(
      oauth1Header("POST", URL, creds, opts)
    );
  });

  it("changes the signature when the nonce changes", () => {
    const a = oauth1Header("POST", URL, creds, {
      nonce: "one",
      timestamp: "1700000000",
    });
    const b = oauth1Header("POST", URL, creds, {
      nonce: "two",
      timestamp: "1700000000",
    });
    expect(a).not.toBe(b);
  });
});
