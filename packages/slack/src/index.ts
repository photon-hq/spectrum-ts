import { createClient, staticTokens } from "@photon-ai/slack";
import { definePlatform, UnsupportedError } from "@spectrum-ts/core";
import { createCloudClients, disposeCloudAuth } from "./auth";
import { messages, send } from "./messages";
import {
  configSchema,
  isCloudConfig,
  messageSchema,
  type SlackClients,
  spaceParamsSchema,
  spaceSchema,
  userSchema,
} from "./types";

export const slack = definePlatform("Slack", {
  config: configSchema,

  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
    }): Promise<SlackClients> => {
      if (!isCloudConfig(config)) {
        return createClient({
          spectrumSlackEndpoint: config.endpoint,
          tokenProvider: staticTokens({
            tokens: config.tokens,
            teams: config.teams,
          }),
        });
      }

      if (!(projectId && projectSecret)) {
        throw new Error(
          "Slack cloud mode requires projectId and projectSecret. " +
            "Either pass credentials to Spectrum(), or provide direct credentials: " +
            "slack.config({ tokens: { T012ABCDE: 'jwt...' } })"
        );
      }

      return await createCloudClients(
        projectId,
        projectSecret,
        process.env.SPECTRUM_SLACK_ENDPOINT
      );
    },

    destroyClient: async ({ client }) => {
      await disposeCloudAuth(client);
      await client.close();
    },
  },

  user: {
    schema: userSchema,
    resolve: async ({ input }) => ({ id: input.userID }),
  },

  space: {
    schema: spaceSchema,
    params: spaceParamsSchema,
    create: async ({ input }) => {
      const teamId = input.params?.teamId;
      if (!teamId) {
        throw new Error(
          "Slack space creation requires a teamId param. " +
            "Pass it via space.create(user, { teamId })."
        );
      }
      if (input.users.length > 1) {
        throw UnsupportedError.action(
          "space.create",
          "Slack",
          "group DMs require an explicit channel id (Slack's conversations.open is not exposed); use space.get(channelId, { teamId })"
        );
      }
      const user = input.users[0];
      if (!user) {
        throw new Error("Slack space creation requires a user");
      }
      // Slack accepts a user id (`U...`) as a `channel` for DMs. Skip
      // `conversations.open` — the runtime resolves the IM channel on send.
      return { id: user.id, teamId };
    },
    get: async ({ input }) => {
      const teamId = input.params?.teamId;
      if (!teamId) {
        throw new Error(
          "Slack spaces require a teamId param. " +
            "Pass it via space.get(channelId, { teamId })."
        );
      }
      return { id: input.id, teamId };
    },
  },

  message: {
    schema: messageSchema,
  },

  // Discover the team list at subscribe time from the live `TokenProvider`.
  // Direct mode: `staticTokens.listTeams` returns whatever `teams` metadata
  // the caller passed (we fall back to the `tokens` keys when absent).
  // Cloud mode: our renewing provider returns the live `auth` snapshot.
  messages: ({ client, config }) =>
    messages(client, async () => {
      const teams = await client.teams();
      if (teams.size > 0) {
        return Array.from(teams.keys());
      }
      if (isCloudConfig(config)) {
        return [];
      }
      return Object.keys(config.tokens);
    }),

  send: async ({ space, content, client }) =>
    await send(client, { id: space.id, teamId: space.teamId }, content),
});
