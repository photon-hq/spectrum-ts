import { DEFAULT_BASE_URL } from "./config";

const LEADING_AT = /^@/;

interface UserLookupResponse {
  data?: { id?: string; username?: string };
}

/**
 * Resolve an X numeric user id from a `@handle` via
 * `GET /2/users/by/username/{username}`. App-only bearer auth is sufficient
 * (public read). Throws on a non-2xx response or a missing id.
 */
export const lookupXUserId = async (
  appBearerToken: string,
  username: string,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<string> => {
  const handle = username.replace(LEADING_AT, "");
  const response = await fetch(
    `${baseUrl}/2/users/by/username/${encodeURIComponent(handle)}`,
    { headers: { Authorization: `Bearer ${appBearerToken}` } }
  );
  const body = (await response.json().catch(() => ({}))) as UserLookupResponse;
  const id = body.data?.id;
  if (!(response.ok && id)) {
    throw new Error(
      `X user lookup failed for @${handle} (status ${response.status})`
    );
  }
  return id;
};
