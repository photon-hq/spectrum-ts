import {
  createClient,
  type SlackClient,
  type TeamMetadata,
  type TokenProvider,
} from "@photon-ai/slack";
import { cloud, type SlackTokenData } from "@spectrum-ts/core";
import { createLogger, errorAttrs } from "@spectrum-ts/core/authoring";

const log = createLogger("spectrum.slack.auth");

const RENEWAL_RATIO = 0.8;
const EXPIRY_BUFFER_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

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
  let tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  let disposed = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshFailures = 0;

  const clearRenewalTimer = () => {
    if (renewalTimer !== undefined) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }
  };

  const refreshTokens = async (): Promise<void> => {
    tokenData = await cloud.issueSlackTokens(projectId, projectSecret);
    tokenExpiresAt = Date.now() + tokenData.expiresIn * 1000;
  };

  const onRefreshSuccess = () => {
    if (refreshFailures > 0) {
      log.info("slack token refresh recovered", {
        "spectrum.slack.auth.attempt": refreshFailures,
      });
      refreshFailures = 0;
    }
  };

  const onRefreshFailure = (error: unknown) => {
    refreshFailures += 1;
    log.warn(
      "slack token refresh failed; retrying",
      {
        "spectrum.slack.auth.attempt": refreshFailures,
        "spectrum.slack.auth.retry_in_ms": RETRY_DELAY_MS,
        ...errorAttrs(error),
      },
      error
    );
  };

  const scheduleRetry = () => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    renewalTimer = setTimeout(async () => {
      if (disposed) {
        return;
      }
      try {
        await refreshTokens();
        onRefreshSuccess();
        scheduleRenewal();
      } catch (retryErr) {
        onRefreshFailure(retryErr);
        scheduleRetry();
      }
    }, RETRY_DELAY_MS);
    renewalTimer?.unref?.();
  };

  const scheduleRenewal = () => {
    if (disposed) {
      return;
    }
    clearRenewalTimer();
    const ttlMs = tokenData.expiresIn * 1000;
    const renewInMs = Math.max(ttlMs * RENEWAL_RATIO, 5000);

    renewalTimer = setTimeout(async () => {
      try {
        await refreshTokens();
        onRefreshSuccess();
        scheduleRenewal();
      } catch (err) {
        onRefreshFailure(err);
        scheduleRetry();
      }
    }, renewInMs);
    renewalTimer?.unref?.();
  };

  const refreshIfNeeded = async (): Promise<void> => {
    if (Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
      return;
    }
    await refreshTokens();
    onRefreshSuccess();
    scheduleRenewal();
  };

  scheduleRenewal();

  const tokenProvider: TokenProvider = {
    async getAccessToken(teamId: string): Promise<string> {
      await refreshIfNeeded();
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
      tokenExpiresAt = 0;
    },
    async listTeams() {
      await refreshIfNeeded();
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
      disposed = true;
      clearRenewalTimer();
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
