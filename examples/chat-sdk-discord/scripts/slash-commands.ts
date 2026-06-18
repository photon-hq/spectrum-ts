// Slash commands (a Discord interaction) — now surfaced through Spectrum itself.
// Interactions aren't messages and arrive over the interactions HTTP webhook
// (not the Gateway), so serve the platform's `webhook` next to the message loop.
// Both land on the SAME `app.messages` stream: a slash command shows up as a
// custom host-event record you read with `chatHostEvent(message)`.
//
// Register the command once (not done here), e.g.
//   PUT https://discord.com/api/v10/applications/{appId}/commands
//   { "name": "ping", "description": "Ping the bot", "type": 1 }
// Expose :3000 with a tunnel and set it as the Interactions Endpoint URL
// (`https://<tunnel>/webhooks/discord`).
//
// Run: bun slash-commands  (then run /ping, or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { Spectrum } from "spectrum-ts";
import { chatHostEvent, chatSDK } from "spectrum-ts/providers/chat-sdk";

const discord = chatSDK(createDiscordAdapter());

const app = await Spectrum({
  providers: [discord.config({ userName: "spectrum-bot" })],
});

// Messages flow over the Gateway (auto); interactions over this webhook. Both
// feed `app.messages`.
Bun.serve({
  port: 3000,
  routes: {
    "/webhooks/discord": { POST: discord(app).webhook },
  },
});
console.log("listening for interactions on :3000/webhooks/discord");

for await (const [space, message] of app.messages) {
  const event = chatHostEvent(message);

  // A slash command — `event` is narrowed to the slash-command payload.
  if (event?.chatsdk_type === "slash-command") {
    await space.send(`🏓 pong — you ran ${event.command} ${event.text}`.trim());
    continue;
  }

  // A button click from a card the bot posted.
  if (event?.chatsdk_type === "action") {
    await space.send(`you clicked ${event.actionId}`);
    continue;
  }

  if (message.content.type === "text") {
    await space.send(`Echo: ${message.content.text}`);
  }
}
