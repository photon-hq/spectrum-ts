import { type FusorClient, fusor } from "../../fusor";
import { definePlatform } from "../../platform/define";
import { configSchema, TELEGRAM_PLATFORM } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { resolveSpace, resolveUser, spaceParamsSchema } from "./space";
import type { TelegramPayload } from "./types";
import { verify } from "./verify";

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
 */
export const telegram = definePlatform(TELEGRAM_PLATFORM, {
  config: configSchema,
  lifecycle: {
    // Annotate the return so overload selection sees the `FusorClient` brand
    // without deferring this (context-sensitive) arrow — picks the fusor overload.
    createClient: async ({ config }): Promise<FusorClient<TelegramPayload>> =>
      fusor<TelegramPayload>(TELEGRAM_PLATFORM, verify(config)),
  },
  user: { resolve: resolveUser },
  space: { params: spaceParamsSchema, resolve: resolveSpace },
  messages: handleMessages,
  send,
});
