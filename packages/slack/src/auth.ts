import {
  createClient,
  type SlackClient,
  type TeamMetadata,
  type TokenProvider,
} from "@photon-ai/slack";
import { cloud, type SlackTokenData } from "@spectrum-ts/core";
import { createTokenRenewal } from "@spectrum-ts/core/authoring";

interface CloudAuth {
  dispose: () => Promise<void>;
}

const cloudAuthState = new WeakMap<SlackClient, CloudAuth>();

const toTeamMetadata = (
  meta: SlackTokenData["teams"][string]
): TeamMetadata => ({
  appId: meta.appId,
  botUserId: meta.botUserId,
  grantedScopes: meta.grantedScopes,
  teamName: meta.teamName,
});

/**
 * Build a {@link SlackClient} backed by a {@link TokenProvider} that lazily
 * refreshes its tokens against `POST /projects/:id/slack/tokens` on TTL or on
 * an UNAUTHENTICATED bounce (slack-ts middleware calls `invalidate(teamId)`).
 *
 * Token + team metadata are kept in a single snapshot, refreshed atomically.
 * `listTeams()` returns the latest snapshot so `client.teams()` always
 * reflects active installations — used by the slack provider's message stream
 * to discover which workspaces to subscribe to.
 */
export async function createCloudClients(
  projectId: string,
  projectSecret: string,
  endpoint: string | undefined
): Promise<SlackClient> {
  let tokenData = await cloud.issueSlackTokens(projectId, projectSecret);
  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "slack",
    refresh: async () => {
      tokenData = await cloud.issueSlackTokens(projectId, projectSecret);
    },
  });

  const tokenProvider: TokenProvider = {
    async getAccessToken(teamId: string): Promise<string> {
      await renewal.refreshIfNeeded();
      const token = tokenData.auth[teamId];
      if (!token) {
        throw new Error(
          `Slack team ${teamId} has no active installation in this project`
        );
      }
      return token;
    },
    invalidate(_teamId: string): void {
      // Force the next `getAccessToken` to refetch by pulling expiry forward.
      // slack-ts's auth middleware calls this on UNAUTHENTICATED — clearing
      // the deadline is enough; the next call awaits refresh before stamping.
      renewal.invalidate();
    },
    async listTeams() {
      await renewal.refreshIfNeeded();
      const entries: [string, TeamMetadata][] = Object.entries(
        tokenData.teams
      ).map(([teamId, meta]) => [teamId, toTeamMetadata(meta)]);
      return new Map(entries);
    },
  };

  const client = createClient({
    spectrumSlackEndpoint: endpoint,
    tokenProvider,
  });

  cloudAuthState.set(client, {
    dispose: async () => {
      renewal.dispose();
    },
  });

  return client;
}

export async function disposeCloudAuth(client: SlackClient): Promise<void> {
  const auth = cloudAuthState.get(client);
  if (!auth) {
    return;
  }
  await auth.dispose();
  cloudAuthState.delete(client);
}
