import {
  definePlatform,
  type FusorClient,
  fusor,
  type Message,
} from "@spectrum-ts/core";
import { configSchema, DISCORD_PLATFORM, type DiscordConfig } from "./config";
import { handleMessages } from "./inbound/messages";
import { pin, unpin } from "./outbound/pin";
import { send } from "./outbound/send";
import {
  type CreateThreadOptions,
  createThread,
  type StartThreadOptions,
  startThread,
} from "./outbound/thread";
import { createSpace, resolveUser } from "./space";
import type { DiscordPayload } from "./types";
import { verify } from "./verify";

export type { DiscordConfig } from "./config";
// biome-ignore lint/performance/noBarrelFile: provider entrypoint exports its public helpers
export {
  type ActionRow,
  ButtonStyle,
  button,
  type Components,
  components,
  linkButton,
  row,
  select,
} from "./content/components";
export { type Embed, embed } from "./content/embed";

/**
 * Discord provider for Spectrum.
 *
 * Inbound is delivered through Fusor: Fusor holds the Discord Gateway connection
 * and relays each dispatch frame to Spectrum, so `createClient` returns a
 * `fusor(...)` client whose `verify` parses the relayed event (`{ t, d }`) —
 * pure parsing, no client, and no per-event signature (the authenticated Fusor
 * plane is the trust boundary). The `messages` handler maps `MESSAGE_CREATE`
 * (including `poll` messages), `MESSAGE_UPDATE`, `MESSAGE_DELETE`,
 * `MESSAGE_REACTION_ADD`/`MESSAGE_REACTION_REMOVE` and
 * `MESSAGE_POLL_VOTE_ADD`/`MESSAGE_POLL_VOTE_REMOVE` to Spectrum messages,
 * reading `config` from its ctx and building a REST client inline to fetch
 * attachment bytes or resolve a poll a vote refers to. Outbound (`send`) calls
 * the Discord REST API directly with `fetch` (including native polls). Drop
 * `discord.config({...})` into `Spectrum({ providers: [...] })`.
 *
 * Threads: a Discord thread id is a channel snowflake, so sending and receiving
 * in an existing thread already works through the normal space path
 * (`space.get(threadId).send(...)`). The instance actions `startThread` (from an
 * existing message) and `createThread` (a standalone text thread) open a new
 * thread and return its id for exactly that.
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
  // Instance actions surface on the platform instance. `startThread`/`createThread`
  // return data (a thread snowflake the caller passes to
  // `discord(spectrum).space.get(id)`); `pin`/`unpin` toggle a message's pinned
  // state and resolve to void. The Discord client here is Fusor (inbound only), so
  // the REST client is built from `config`, matching `send`.
  actions: {
    startThread: (
      { config }: { config: DiscordConfig },
      message: Message,
      name: string,
      options?: StartThreadOptions
    ): Promise<string> => startThread({ config, message, name, options }),
    createThread: (
      { config }: { config: DiscordConfig },
      channelId: string,
      name: string,
      options?: CreateThreadOptions
    ): Promise<string> => createThread({ config, channelId, name, options }),
    pin: (
      { config }: { config: DiscordConfig },
      message: Message
    ): Promise<void> => pin({ config, message }),
    unpin: (
      { config }: { config: DiscordConfig },
      message: Message
    ): Promise<void> => unpin({ config, message }),
  },
});
