// Inbound enrichment via `messageMeta(message)`.
//
// Beyond text/attachments, the chat SDK normalizes mention state, edited state,
// and link previews. `messageMeta` exposes them typed, with no casting.
//
// Run: bun run enrichment.ts  (then @-mention the bot, edit a message, or paste a link)

import { Spectrum } from "spectrum-ts";
import { chatSDK, messageMeta } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  const { isMention, edited, editedAt, links } = messageMeta(message);

  const parts = [
    `text: ${message.content.text}`,
    `mention: ${isMention}`,
    `edited: ${edited}${edited && editedAt ? ` @ ${editedAt.toISOString()}` : ""}`,
    `links: ${links.length}`,
  ];
  if (links.length > 0) {
    parts.push(links.map((l) => `• ${l.title ?? l.url}`).join("\n"));
  }

  await space.send(parts.join("\n"));
}
