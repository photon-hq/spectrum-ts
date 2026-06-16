import { type FusorClient, fusor } from "../../fusor";
import { definePlatform } from "../../platform/define";
import { configSchema, DISCORD_PLATFORM } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { createSpace, resolveUser } from "./space";
import type { DiscordPayload } from "./types";
import { verify } from "./verify";

export type { DiscordConfig } from "./config";

/**
 * Discord provider for Spectrum.
 *
 * Inbound is delivered through Fusor: Fusor holds the Discord Gateway connection
 * and relays each dispatch frame to Spectrum, so `createClient` returns a
 * `fusor(...)` client whose `verify` parses the relayed event (`{ t, d }`) —
 * pure parsing, no client, and no per-event signature (the authenticated Fusor
 * plane is the trust boundary). The `messages` handler maps `MESSAGE_CREATE`,
 * `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD` and
 * `MESSAGE_REACTION_REMOVE` to Spectrum messages, reading `config` from its ctx and
 * building a REST client inline only to fetch attachment bytes. Outbound
 * (`send`) calls the Discord REST API directly with `fetch`. Drop
 * `discord.config({...})` into `Spectrum({ providers: [...] })`.
 *
 * Unlike Telegram, there is no webhook to self-register: Fusor owns the Gateway
 * connection (using the bot token), so the provider only wires up verify/map.
 */
export const discord = definePlatform(DISCORD_PLATFORM, {
  config: configSchema,
  lifecycle: {
    // Annotate the return so overload selection sees the `FusorClient` brand
    // without deferring this (context-sensitive) arrow — picks the fusor overload.
    createClient: ({ config }): Promise<FusorClient<DiscordPayload>> =>
      Promise.resolve(fusor<DiscordPayload>(DISCORD_PLATFORM, verify(config))),
  },
  user: { resolve: resolveUser },
  space: { create: createSpace },
  messages: handleMessages,
  send,
});
