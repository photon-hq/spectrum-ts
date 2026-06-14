import { type FusorClient, fusor } from "../../fusor";
import { definePlatform } from "../../platform/define";
import { createCloudAuth, getCloudAuth } from "./auth";
import {
  configSchema,
  DEFAULT_BASE_URL,
  isCloudConfig,
  X_PLATFORM,
} from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";
import type { XPayload } from "./types";
import { makeVerify, verify } from "./verify";
import { ensureWebhook } from "./webhook";

export type { XCloudConfig, XConfig, XDirectConfig } from "./config";
// biome-ignore lint/performance/noBarrelFile: provider entrypoint re-exports config helpers
export { isCloudConfig } from "./config";
export { webhookUrl } from "./webhook";

/**
 * X provider for Spectrum.
 *
 * Inbound runs through Fusor (webhook + stream compatible): `verify` handles
 * CRC/signature parsing and `messages` maps DM webhooks to provider records.
 * Outbound sends text DMs through the X REST API.
 *
 * Cloud mode exchanges credentials via Spectrum Cloud (`POST /x/credentials`);
 * pass `appBearerToken` in cloud config to register the Fusor webhook at startup.
 * Direct mode uses static config and registers the Fusor webhook the same way.
 */
export const x = definePlatform(X_PLATFORM, {
  config: configSchema,
  lifecycle: {
    createClient: async ({
      config,
      projectId,
      projectSecret,
      projectConfig,
      store,
    }): Promise<FusorClient<XPayload>> => {
      if (isCloudConfig(config)) {
        if (!(projectId && projectSecret)) {
          throw new Error(
            "X cloud mode requires projectId and projectSecret on Spectrum(). " +
              "Either pass credentials to Spectrum(), or use direct credentials: " +
              "x.config({ consumerSecret, accessToken, xUserId, appBearerToken })"
          );
        }
        const auth = await createCloudAuth({
          projectId,
          projectSecret,
          pinnedXUserId: config.xUserId,
          store,
        });
        const slug = projectConfig?.slug;
        if (slug && config.appBearerToken) {
          const accessToken = await auth.getAccessToken();
          await ensureWebhook(
            {
              appBearerToken: config.appBearerToken,
              accessToken,
              baseUrl: DEFAULT_BASE_URL,
            },
            slug,
            config.webhookBaseUrl
          );
        }
        return fusor<XPayload>(
          X_PLATFORM,
          makeVerify(auth, config.consumerSecret)
        );
      }

      const directConfig = config;
      const slug = projectConfig?.slug;
      if (slug) {
        await ensureWebhook(
          {
            appBearerToken: directConfig.appBearerToken,
            accessToken: directConfig.accessToken,
            baseUrl: directConfig.baseUrl,
          },
          slug
        );
      }
      return fusor<XPayload>(X_PLATFORM, verify(directConfig));
    },
    destroyClient: async ({ store }) => {
      getCloudAuth(store)?.dispose();
    },
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: handleMessages,
  send,
});
