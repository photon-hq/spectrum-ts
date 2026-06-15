import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { XRefreshConfig, XRefreshedTokens } from "@/providers/x/config";
import {
  createDirectAuth,
  X_DIRECT_AUTH_STORE_KEY,
} from "@/providers/x/direct-auth";
import { createStore } from "@/utils/store";

const baseConfig: XRefreshConfig = {
  consumerSecret: "cs",
  accessToken: "bootstrap-access",
  xUserId: "42",
  appBearerToken: "bearer",
  baseUrl: "https://api.x.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "rt-0",
  tokenUrl: "https://token.local/oauth2/token",
};

const fetchReturning = (body: unknown, status = 200) =>
  spyOn(globalThis, "fetch").mockImplementation((() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status })
    )) as unknown as typeof fetch);

const fetchSequence = () =>
  spyOn(globalThis, "fetch").mockImplementation((() => {
    fetchSequence.calls += 1;
    const n = fetchSequence.calls;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: `at-${n}`,
          refresh_token: `rt-${n}`,
          expires_in: 10,
        }),
        { status: 200 }
      )
    );
  }) as unknown as typeof fetch);
fetchSequence.calls = 0;

describe("createDirectAuth", () => {
  afterEach(() => {
    mock.restore();
    fetchSequence.calls = 0;
  });

  it("refreshes on create and exposes the fresh token", async () => {
    fetchReturning({
      access_token: "fresh-1",
      refresh_token: "rt-1",
      expires_in: 7200,
    });
    const store = createStore();
    const auth = await createDirectAuth({ config: baseConfig, store });

    expect(store.get(X_DIRECT_AUTH_STORE_KEY)).toBe(auth);
    await expect(auth.getAccessToken()).resolves.toBe("fresh-1");
  });

  it("surfaces rotated tokens via onTokensRefreshed", async () => {
    fetchReturning({
      access_token: "fresh-1",
      refresh_token: "rt-1",
      expires_in: 7200,
    });
    const seen: XRefreshedTokens[] = [];
    const store = createStore();
    await createDirectAuth({
      config: {
        ...baseConfig,
        onTokensRefreshed: (t) => {
          seen.push(t);
        },
      },
      store,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.refreshToken).toBe("rt-1");
  });

  it("dedupes concurrent refreshes (single-flight)", async () => {
    const fetchSpy = fetchReturning({
      access_token: "a",
      refresh_token: "r",
      expires_in: 10,
    });
    const store = createStore();
    const auth = await createDirectAuth({ config: baseConfig, store });
    // expires_in=10 < 30s buffer, so each getAccessToken needs a refresh; the
    // three concurrent calls must collapse to a single fetch.
    await Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refreshes with the rotated token, not the configured one", async () => {
    const fetchSpy = fetchSequence();
    const store = createStore();
    const auth = await createDirectAuth({ config: baseConfig, store });
    await auth.getAccessToken();

    const secondInit = fetchSpy.mock.calls[1]?.[1];
    expect(String(secondInit?.body)).toContain("refresh_token=rt-1");
  });

  it("dispose clears the store and rejects further use", async () => {
    fetchReturning({
      access_token: "a",
      refresh_token: "r",
      expires_in: 7200,
    });
    const store = createStore();
    const auth = await createDirectAuth({ config: baseConfig, store });

    auth.dispose();
    expect(store.get(X_DIRECT_AUTH_STORE_KEY)).toBeUndefined();
    await expect(auth.getAccessToken()).rejects.toThrow("disposed");
  });
});
