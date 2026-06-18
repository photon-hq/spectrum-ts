// Discord embed via the `custom` passthrough. Spectrum doesn't model rich cards,
// but the chat SDK's `Card` does and the adapter renders it to a native embed.
// `custom(raw)` forwards the payload straight to the adapter's `post()`.
//
// Run: bun embed  (then @-mention or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { Actions, Card, LinkButton } from "chat";
import { custom, Spectrum } from "spectrum-ts";
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

  const card = Card({
    title: "Spectrum × Chat SDK",
    subtitle: `You said: ${message.content.text}`,
    children: [
      Actions([
        LinkButton({ url: "https://photon.codes", label: "Open Photon" }),
      ]),
    ],
  });

  await space.send(custom({ card, fallbackText: "Spectrum × Chat SDK" }));
}
