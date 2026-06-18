// Baseline echo. `chatSDK(adapter)` makes the Discord adapter its own Spectrum
// platform; pass no handlers (Spectrum is the handler). Messages arrive over the
// Gateway, opened for you — no HTTP server.
//
// Run: bun echo  (then @-mention or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(`Echo: ${message.content.text}`);
  }
}
