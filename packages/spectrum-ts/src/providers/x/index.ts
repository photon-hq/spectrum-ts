import { type FusorClient, fusor } from "../../fusor";
import { definePlatform } from "../../platform/define";
import { configSchema, X_PLATFORM } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";
import type { XPayload } from "./types";
import { verify } from "./verify";
import { ensureWebhook } from "./webhook";

export type { XConfig } from "./config";

/**
 * X provider for Spectrum.
 *
 * Inbound runs through Fusor (webhook + stream compatible): `verify` handles
 * CRC/signature parsing and `messages` maps DM webhooks to provider records.
 * Outbound sends text DMs through the X REST API.
 */
export const x = definePlatform(X_PLATFORM, {
  config: configSchema,
  lifecycle: {
    createClient: async ({
      config,
      projectConfig,
    }): Promise<FusorClient<XPayload>> => {
      const slug = projectConfig?.slug;
      if (slug) {
        await ensureWebhook(config, slug);
      }
      return fusor<XPayload>(X_PLATFORM, verify(config));
    },
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: handleMessages,
  send,
});
