import { type FusorClient, fusor } from "../../fusor";
import { definePlatform } from "../../platform/define";
import { initClient } from "./client";
import { configSchema, TELEGRAM_PLATFORM } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { resolveSpace, resolveUser, spaceParamsSchema } from "./space";
import type { TelegramPayload } from "./types";
import { makeVerify } from "./verify";

export type { TelegramConfig } from "./config";

/**
 * Telegram provider for Spectrum.
 *
 * Inbound is delivered through Fusor: `createClient` builds the Bot API client
 * and returns a `fusor(...)` client whose `verify` checks the Telegram webhook
 * secret token and parses the `Update` (embedding the client so inbound media
 * can be downloaded lazily with the bot token). Outbound goes through the
 * Telegram Bot API over HTTP. Drop `telegram.config({...})` into
 * `Spectrum({ providers: [...] })`.
 */
export const telegram = definePlatform(TELEGRAM_PLATFORM, {
  config: configSchema,
  lifecycle: {
    // Annotate the return so overload selection sees the `FusorClient` brand
    // without deferring this (context-sensitive) arrow — picks the fusor overload.
    createClient: async ({
      config,
      store,
    }): Promise<FusorClient<TelegramPayload>> => {
      const client = initClient(store, config);
      return fusor<TelegramPayload>(
        TELEGRAM_PLATFORM,
        makeVerify(config, client)
      );
    },
  },
  user: { resolve: resolveUser },
  space: { params: spaceParamsSchema, resolve: resolveSpace },
  messages: handleMessages,
  send,
});
