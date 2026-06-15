import type { XRefreshedTokens } from "./config";

interface RefreshInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
}

interface XTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

const basicAuth = (clientId: string, clientSecret: string): string =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

/**
 * Refresh a BYO-app user access token directly against X's OAuth2 token
 * endpoint (no Spectrum Cloud). X rotates the refresh token on every call, so
 * the returned `refreshToken` must replace the one used — falling back to the
 * sent token only if X omits a new one. Throws on a non-2xx or malformed
 * response so the caller can retry.
 */
export const refreshXAccessToken = async ({
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl,
}: RefreshInput): Promise<XRefreshedTokens> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: basicAuth(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as XTokenResponse;

  if (!response.ok) {
    throw new Error(`X token refresh failed: ${response.status}`);
  }

  const accessToken =
    typeof payload.access_token === "string" && payload.access_token.length > 0
      ? payload.access_token
      : undefined;
  const expiresIn = payload.expires_in;
  if (!(accessToken && typeof expiresIn === "number" && expiresIn > 0)) {
    throw new Error(
      "X token refresh response is missing access_token or expires_in"
    );
  }

  return {
    accessToken,
    expiresIn,
    // X rotates the refresh token; keep the prior one only if none returned.
    refreshToken:
      typeof payload.refresh_token === "string" &&
      payload.refresh_token.length > 0
        ? payload.refresh_token
        : refreshToken,
  };
};
