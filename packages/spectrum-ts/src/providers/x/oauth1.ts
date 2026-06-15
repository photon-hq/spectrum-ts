/**
 * OAuth 1.0a User Context request signing for X.
 *
 * Builds `Authorization: OAuth …` headers signed with HMAC-SHA1 per the X
 * spec. Used by `webhook.ts` for account-activity / subscription endpoints
 * when four-part 1.0a credentials are available. Credentials: consumer
 * key/secret plus access token/secret.
 *
 * For OAuth 2.0 refresh-token exchange (client ID/secret + refresh token),
 * see `oauth.ts` instead — that module renews Bearer tokens; it does not
 * sign individual requests.
 */
import { createHmac, randomBytes } from "node:crypto";

export interface OAuth1Credentials {
  accessToken: string;
  accessTokenSecret: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface OAuth1Options {
  /** Override the nonce (tests); defaults to 16 random bytes hex-encoded. */
  nonce?: string;
  /** Override the timestamp in epoch seconds (tests); defaults to now. */
  timestamp?: string;
}

// encodeURIComponent leaves these unescaped, but RFC 3986 / OAuth 1.0a require
// them percent-encoded.
const RESERVED_EXTRA = /[!*'()]/g;

const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    RESERVED_EXTRA,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

/**
 * Build an `Authorization: OAuth …` header for an OAuth 1.0a User Context
 * request, signed HMAC-SHA1 per the X spec.
 *
 * `url` must have no query string, and the request must not carry a
 * form-encoded body — X's account-activity and DM v2 endpoints take JSON
 * bodies, which are excluded from the OAuth signature base string.
 */
export const oauth1Header = (
  method: string,
  url: string,
  creds: OAuth1Credentials,
  options: OAuth1Options = {}
): string => {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: options.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:
      options.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.entries(params)
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .sort()
    .join("&");

  const baseString = `${method.toUpperCase()}&${rfc3986(url)}&${rfc3986(paramString)}`;
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessTokenSecret)}`;
  // OAuth 1.0a mandates HMAC-SHA1 — this is the protocol, not a security choice.
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  return `OAuth ${Object.entries({ ...params, oauth_signature: signature })
    .map(([key, value]) => `${rfc3986(key)}="${rfc3986(value)}"`)
    .sort()
    .join(", ")}`;
};
