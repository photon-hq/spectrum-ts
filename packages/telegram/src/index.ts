import { definePlatform, type FusorClient, fusor } from "@spectrum-ts/core";
import { configSchema, TELEGRAM_PLATFORM } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";
import type { TelegramPayload } from "./types";
import { verify } from "./verify";
import { ensureWebhook } from "./webhook";

export type { TelegramConfig } from "./config";

/**
 * Telegram provider for Spectrum.
 *
 * Inbound is delivered through Fusor: `createClient` returns a `fusor(...)`
 * client whose `verify` checks the Telegram webhook secret token and parses the
 * `Update` (pure parsing — no client). The `messages` handler reads `config`
 * from its ctx and builds a photon client inline only to download media bytes.
 * Outbound (`send`) also builds a photon client inline. Both go through
 * `@photon-ai/telegram-ts`. Drop `telegram.config({...})` into
 * `Spectrum({ providers: [...] })`.
 *
 * In cloud mode (`projectConfig` present), `createClient` also self-registers
 * the bot's webhook against the Fusor edge for the project slug — see
 * `ensureWebhook`. Without a slug (local/direct mode) registration is skipped.
 */
export const telegram = definePlatform(TELEGRAM_PLATFORM, {
  config: configSchema,
  lifecycle: {
    // Annotate the return so overload selection sees the `FusorClient` brand
    // without deferring this (context-sensitive) arrow — picks the fusor overload.
    createClient: async ({
      config,
      projectConfig,
    }): Promise<FusorClient<TelegramPayload>> => {
      const slug = projectConfig?.slug;
      if (slug) {
        await ensureWebhook(config, slug);
      }
      return fusor<TelegramPayload>(TELEGRAM_PLATFORM, verify(config));
    },
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: handleMessages,
  send,
});
