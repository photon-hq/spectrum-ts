import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { refreshXAccessToken } from "@/providers/x/oauth";

const tokenUrl = "https://token.local/oauth2/token";
const input = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "rt-old",
  tokenUrl,
};

const mockFetch = (body: unknown, status = 200) =>
  spyOn(globalThis, "fetch").mockImplementation((() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status })
    )) as unknown as typeof fetch);

describe("refreshXAccessToken", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns rotated tokens on success", async () => {
    mockFetch({
      access_token: "at-new",
      refresh_token: "rt-new",
      expires_in: 7200,
    });
    await expect(refreshXAccessToken(input)).resolves.toEqual({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresIn: 7200,
    });
  });

  it("keeps the prior refresh token when X omits a new one", async () => {
    mockFetch({ access_token: "at-new", expires_in: 7200 });
    const tokens = await refreshXAccessToken(input);
    expect(tokens.refreshToken).toBe("rt-old");
  });

  it("throws on a non-2xx response", async () => {
    mockFetch({ error: "invalid_grant" }, 400);
    await expect(refreshXAccessToken(input)).rejects.toThrow(
      "X token refresh failed: 400"
    );
  });

  it("throws when access_token or expires_in is missing", async () => {
    mockFetch({ access_token: "at-new" });
    await expect(refreshXAccessToken(input)).rejects.toThrow(
      "missing access_token or expires_in"
    );
  });

  it("sends a refresh_token grant with the client id", async () => {
    const fetchSpy = mockFetch({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 100,
    });
    await refreshXAccessToken(input);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(tokenUrl);
    expect(init?.method).toBe("POST");
    const sent = String(init?.body);
    expect(sent).toContain("grant_type=refresh_token");
    expect(sent).toContain("refresh_token=rt-old");
    expect(sent).toContain("client_id=client-id");
  });
});
