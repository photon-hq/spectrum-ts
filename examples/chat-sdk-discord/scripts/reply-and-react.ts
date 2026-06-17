// Reply + react + typing.
//
// Shows the conversational basics routed through Spectrum's universal API:
//   - `space.responding(fn)` brackets the work with typing on/off
//   - `message.reply(...)` posts a (threaded) reply
//   - `message.react(emoji)` adds a reaction
//
// Run: bun run reply-and-react.ts  (then @-mention or DM the bot)

import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  const { text } = message.content;

  await space.responding(async () => {
    await message.reply(`You said: ${text}`);
  });

  try {
    await message.react("👀");
  } catch (error) {
    console.warn("reaction skipped:", (error as Error).message);
  }
}
