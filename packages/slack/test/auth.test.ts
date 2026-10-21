import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTeamMetadata {
  appId: string;
  botUserId: string;
  grantedScopes: string[];
  teamName: string;
}

interface FakeTokenData {
  auth: Record<string, string>;
  expiresIn: number;
  teams: Record<string, FakeTeamMetadata>;
}

interface FakeTokenProvider {
  getAccessToken(teamId: string): Promise<string>;
  invalidate(teamId: string): void;
  listTeams(): Promise<Map<string, FakeTeamMetadata>>;
}

const initialTokenData: FakeTokenData = {
  auth: { "team-1": "token-1" },
  expiresIn: 3600,
  teams: {
    "team-1": {
      appId: "app-1",
      botUserId: "bot-1",
      grantedScopes: ["chat:write"],
      teamName: "First team",
    },
  },
};

const issueSlackTokens = vi.fn(
  (_projectId: string, _projectSecret: string, _signal?: AbortSignal) =>
    Promise.resolve(initialTokenData)
);
let tokenProvider: FakeTokenProvider | undefined;

const createClient = vi.fn((options: { tokenProvider: FakeTokenProvider }) => {
  tokenProvider = options.tokenProvider;
  return {};
});

vi.doMock("@spectrum-ts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spectrum-ts/core")>();
  return {
    ...actual,
    cloud: { ...actual.cloud, issueSlackTokens },
  };
});

vi.doMock("@photon-ai/slack", () => ({ createClient }));

const { createCloudClients, disposeCloudAuth } = await import("@/auth");
const { slack } = await import("@/index");

describe("slack cloud auth", () => {
  beforeEach(() => {
    issueSlackTokens.mockReset();
    issueSlackTokens.mockResolvedValue(initialTokenData);
    createClient.mockClear();
    tokenProvider = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards lifecycle cancellation to the initial token request without creating a client", async () => {
    vi.useFakeTimers();
    const actualCore =
      await vi.importActual<typeof import("@spectrum-ts/core")>(
        "@spectrum-ts/core"
      );
    const projectLookup = vi
      .spyOn(actualCore.cloud, "getProject")
      .mockResolvedValue({
        id: "project-1",
        name: "Test project",
        profile: {},
        slug: "test-project",
      });
    const platformsLookup = vi
      .spyOn(actualCore.cloud, "getPlatforms")
      .mockResolvedValue({
        imessage: { enabled: false },
        slack: { enabled: false },
        whatsapp_business: { enabled: false },
      });
    const startup = new AbortController();
    const reason = new DOMException("startup deadline", "TimeoutError");
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<FakeTokenData>();
    issueSlackTokens.mockImplementationOnce((_id, _secret, signal) => {
      signal?.addEventListener("abort", () => response.reject(signal.reason), {
        once: true,
      });
      started.resolve();
      return response.promise;
    });
    try {
      const pending = actualCore.Spectrum({
        projectId: "project-1",
        projectSecret: "secret-1",
        providers: [slack.config()],
        signal: startup.signal,
      });
      const rejection = expect(pending).rejects.toBe(reason);
      await started.promise;
      expect(issueSlackTokens).toHaveBeenCalledExactlyOnceWith(
        "project-1",
        "secret-1",
        startup.signal
      );
      startup.abort(reason);
      await rejection;
      expect(createClient).not.toHaveBeenCalled();
      expect(tokenProvider).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      startup.abort(reason);
      projectLookup.mockRestore();
      platformsLookup.mockRestore();
    }
  });

  it("does not keep the startup signal for token renewals", async () => {
    vi.useFakeTimers();
    const startup = new AbortController();
    const client = await createCloudClients(
      "project-1",
      "secret-1",
      undefined,
      startup.signal
    );
    expect(issueSlackTokens.mock.calls[0]?.[2]).toBe(startup.signal);
    startup.abort();
    tokenProvider?.invalidate("team-1");
    expect(await tokenProvider?.getAccessToken("team-1")).toBe("token-1");
    const refreshSignal = issueSlackTokens.mock.calls[1]?.[2];
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal).not.toBe(startup.signal);
    expect(refreshSignal?.aborted).toBe(false);
    await disposeCloudAuth(client);
    expect(refreshSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels and settles pending refreshes before disposal completes", async () => {
    vi.useFakeTimers();
    const client = await createCloudClients("project-1", "secret-1", undefined);
    issueSlackTokens.mockImplementationOnce(
      (_id, _secret, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );
    tokenProvider?.invalidate("team-1");
    const pending = tokenProvider
      ?.getAccessToken("team-1")
      .catch((error: unknown) => error);
    const signal = issueSlackTokens.mock.calls[1]?.[2];
    await disposeCloudAuth(client);
    expect(await pending).toBe(signal?.reason);
    await expect(tokenProvider?.getAccessToken("team-1")).rejects.toMatchObject(
      { name: "AbortError" }
    );
    expect(issueSlackTokens).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels renewal when the Slack constructor throws", async () => {
    vi.useFakeTimers();
    const failure = new Error("constructor failed");
    createClient.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      createCloudClients("project-1", "secret-1", undefined)
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces invalidated token and team metadata refreshes", async () => {
    vi.useFakeTimers();
    let resolveRefresh:
      | ((value: FakeTokenData | PromiseLike<FakeTokenData>) => void)
      | undefined;
    issueSlackTokens.mockResolvedValueOnce(initialTokenData);
    issueSlackTokens.mockImplementationOnce(
      () =>
        new Promise<FakeTokenData>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const client = await createCloudClients("project-1", "secret-1", undefined);
    const provider = tokenProvider;
    if (!provider) {
      throw new Error("expected Slack token provider");
    }

    provider.invalidate("team-1");
    const accessToken = provider.getAccessToken("team-1");
    const teams = provider.listTeams();
    expect(issueSlackTokens).toHaveBeenCalledTimes(2);

    resolveRefresh?.({
      auth: { "team-1": "token-2" },
      expiresIn: 3600,
      teams: {
        "team-1": {
          appId: "app-2",
          botUserId: "bot-2",
          grantedScopes: ["chat:write", "reactions:write"],
          teamName: "Updated team",
        },
      },
    });

    expect(await accessToken).toBe("token-2");
    expect((await teams).get("team-1")?.teamName).toBe("Updated team");
    expect(issueSlackTokens).toHaveBeenCalledTimes(2);
    await disposeCloudAuth(client);
  });
});
