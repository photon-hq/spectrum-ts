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

const issueSlackTokens = vi.fn(() => Promise.resolve(initialTokenData));
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
