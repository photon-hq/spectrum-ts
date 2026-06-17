// Slash commands (a Discord interaction) handled on the bot directly.
//
// Interactions aren't messages, so they don't flow through `app.messages` —
// you register them on the chat-SDK bot itself (cross-platform, normalized),
// and they run alongside Spectrum with no conflict.
//
// Unlike regular messages (which arrive over the Gateway), Discord delivers
// interactions to your Interactions Endpoint URL over HTTP — so YOU serve the
// webhook. We mount `bot.webhooks.discord` on a Bun route below; expose it with
// a tunnel (`ngrok http 3000`) and register the public URL at General
// Information → Interactions Endpoint URL → `https://<tunnel>/webhooks/discord`.
//
// NOTE: you must REGISTER the command with Discord once (it isn't done here) —
// e.g. PUT https://discord.com/api/v10/applications/{appId}/commands
//   { "name": "ping", "description": "Ping the bot", "type": 1 }
// with header `Authorization: Bot <DISCORD_BOT_TOKEN>`.
//
// Run: bun run slash-commands.ts  (then run /ping in your server, or DM the bot)

import { Spectrum } from "spectrum-ts";
import { chatSDK, getBot } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const bot = createBot();

// Interaction handler — fine to register on the bot (it's not a message handler).
bot.onSlashCommand(async (event) => {
  await event.channel.post(
    `🏓 pong — you ran ${event.command} ${event.text}`.trim()
  );
});

const app = await Spectrum({ providers: [chatSDK(bot)] });

// Serve the interaction webhook yourself — the provider no longer binds a port.
// Only interactions (slash commands / buttons) need this; plain messages arrive
// over the Gateway.
Bun.serve({
  port: 3000,
  // Wrap so Bun's (req, server) call doesn't collide with the handler's
  // optional WebhookOptions second argument.
  routes: { "/webhooks/discord": { POST: (req) => bot.webhooks.discord(req) } },
});
console.log("listening for interactions on :3000/webhooks/discord");

// Messages still flow through Spectrum as usual.
let logged = false;
for await (const [space, message] of app.messages) {
  // `getBot(app)` resolves the underlying Chat instance once the app is
  // running — here it's the same instance we constructed above.
  if (!logged) {
    console.log("getBot wired:", getBot(app) === bot);
    logged = true;
  }
  if (message.content.type === "text") {
    await space.send(`Echo: ${message.content.text}`);
  }
}
