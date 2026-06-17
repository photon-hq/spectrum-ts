// Native Discord server ops — run your OWN discord.js client alongside Spectrum.
//
// The chat SDK is messaging-only and doesn't expose its discord.js client, so
// for server/platform features (roles, channels, members, voice, …) you bring
// your own client with the SAME bot token. The bridge is the thread id, which
// encodes `discord:{guildId}:{channelId}:{threadId}` — so any Spectrum `space`
// tells you which guild/channel/member to act on.
//
// Requires, in addition to the usual env:
//   DISCORD_ROLE_ID   — the role to grant
// and the bot needs the "Server Members Intent" + Manage Roles permission, and
// its own role must be ABOVE the granted role in the server's role list.
//
// Run: bun run native-discord-roles.ts  (then @-mention or DM the bot)

import { Client, GatewayIntentBits } from "discord.js";
import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

// Your own client — same token the adapter uses, separate connection.
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
await discord.login(process.env.DISCORD_BOT_TOKEN);

const roleId = process.env.DISCORD_ROLE_ID;

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text" || !message.sender) {
    continue;
  }
  if (!roleId) {
    await space.send("Set DISCORD_ROLE_ID to try the role grant.");
    continue;
  }

  // space.id === "discord:{guildId}:{channelId}:{threadId}"
  const [, guildId] = space.id.split(":");
  if (!guildId) {
    continue;
  }

  const guild = await discord.guilds.fetch(guildId);
  const member = await guild.members.fetch(message.sender.id);
  await member.roles.add(roleId);
  await space.send(`Granted <@&${roleId}> to <@${message.sender.id}>.`);
}
