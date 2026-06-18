// Conversational basics through Spectrum's universal API:
//   space.responding(fn) — brackets the work with typing on/off
//   message.reply(...)    — threaded reply
//   message.react(emoji)  — reaction
//
// Run: bun reply-and-react  (then @-mention or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  const { text } = message.content;
  await space.responding(() => message.reply(`You said: ${text}`));

  try {
    await message.react("👀");
  } catch (error) {
    console.warn("reaction skipped:", (error as Error).message);
  }
}
