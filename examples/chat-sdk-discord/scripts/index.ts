// Run any Vercel chat-SDK adapter (Discord here) through Spectrum's messaging API.
//
// What you need before this runs:
//   1. A Discord app (https://discord.com/developers/applications):
//        - Bot tab → reset/copy the bot token, and turn ON the
//          "Message Content Intent" under Privileged Gateway Intents
//          (without it, gateway messages arrive with empty text).
//        - General Information → copy the Public Key and Application ID.
//      Set them in the environment — the adapter auto-detects:
//        DISCORD_BOT_TOKEN=...
//        DISCORD_PUBLIC_KEY=...
//        DISCORD_APPLICATION_ID=...
//      Then invite the bot to a server (OAuth2 → URL Generator → `bot` +
//      `applications.commands` scopes) so it can see and post messages.
//
// Regular messages arrive over the Gateway, which the provider opens for you —
// so this baseline echo needs no HTTP server and no tunnel. Interactions
// (slash commands / buttons) DO need a public endpoint you serve yourself; see
// slash-commands.ts.
//
// Then: `bun run index.ts`, @-mention or DM your bot, and watch it echo.

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

// 1. Build a chat-SDK bot: adapters + state, but NO message handlers — Spectrum
//    becomes the handler. (Registering your own onNewMention/etc. here would
//    double-reply.) IMPORTANT: the map key must equal the adapter's name
//    ("discord"), or thread resolution fails. Add more adapters to cover more
//    platforms; the wrapper picks them up automatically.
const bot = new Chat({
  userName: "spectrum-bot",
  adapters: {
    // Reads DISCORD_BOT_TOKEN + DISCORD_PUBLIC_KEY + DISCORD_APPLICATION_ID.
    discord: createDiscordAdapter(),
  },
  state: createMemoryState(), // swap for createRedisState() in production
});

// 2. Wrap the bot as a Spectrum provider. The provider keeps the Discord
//    Gateway alive so messages flow in — no HTTP server needed here. (You own
//    serving if you add interactions; see slash-commands.ts.)
const app = await Spectrum({
  providers: [chatSDK(bot)],
});

// 3. From here it's pure Spectrum — your logic lives in this loop, identical to
//    every other Spectrum provider (iMessage, Telegram, …).
for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(`Echo: ${message.content.text}`);
  }
}
