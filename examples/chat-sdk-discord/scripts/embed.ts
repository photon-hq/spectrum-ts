// Discord embed via the `custom` passthrough.
//
// Spectrum doesn't model rich cards — but the chat SDK's `card` does, and the
// Discord adapter renders it to a native embed (+ buttons). `custom(raw)`
// forwards the payload straight to the adapter's `post()`, so anything the
// adapter accepts goes through without the wrapper modeling it.
//
// We build the card with the chat SDK's own `Card`/`Actions`/`LinkButton`
// helpers (so the shape is always valid) and hand it to `custom`.
//
// Run: bun run embed.ts  (then @-mention or DM the bot)

import { Actions, Card, LinkButton } from "chat";
import { custom, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const app = await Spectrum({
  providers: [chatSDK(createBot())],
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
