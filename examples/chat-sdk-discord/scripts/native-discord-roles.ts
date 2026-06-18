// Native Discord server ops — run your OWN discord.js client alongside Spectrum.
// The chat SDK is messaging-only and hides its client, so for roles/channels/
// members you bring your own with the same bot token. The bridge is the space id,
// which decodes to `discord:{guildId}:{channelId}:{threadId}`.
//
// Needs DISCORD_ROLE_ID, the bot's "Server Members Intent" + Manage Roles, and
// the bot's role above the granted role.
// Run: bun native-roles  (then @-mention or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { Client, GatewayIntentBits } from "discord.js";
import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

// Your own client — same token, separate connection.
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
await discord.login(process.env.DISCORD_BOT_TOKEN);

const roleId = process.env.DISCORD_ROLE_ID;

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text" || !message.sender) {
    continue;
  }
  if (!roleId) {
    await space.send("Set DISCORD_ROLE_ID to try the role grant.");
    continue;
  }

  const [, guildId] = space.id.split(":");
  if (!guildId) {
    continue;
  }

  const guild = await discord.guilds.fetch(guildId);
  const member = await guild.members.fetch(message.sender.id);
  await member.roles.add(roleId);
  await space.send(`Granted <@&${roleId}> to <@${message.sender.id}>.`);
}
