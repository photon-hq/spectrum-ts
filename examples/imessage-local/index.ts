import { localIMessage } from "@spectrum-ts/imessage-local";
import { Spectrum, text } from "spectrum-ts";

// Minimal local iMessage echo bot.
//
// Local mode talks straight to the Messages app and chat.db on THIS Mac — no
// cloud project or credentials needed. Your terminal needs Full Disk Access so
// it can read ~/Library/Messages/chat.db. Run with:
//   bun run index.ts
//
// The local provider lives in its own package (`@spectrum-ts/imessage-local`)
// and is not part of the batteries-included `spectrum-ts` aggregate. It uses
// the platform id "local_imessage", so a macOS app can register both cloud and
// local iMessage side by side.
const app = await Spectrum({
  providers: [localIMessage.config()],
});

console.log("Local iMessage bot listening — text the Mac's line to try it.");

for await (const [space, message] of app.messages) {
  // Only handle inbound text; skip attachments and our own sends.
  if (message.direction === "outbound" || message.content.type !== "text") {
    continue;
  }

  const incoming = message.content.text;

  // Local mode supports plain sends but not tapbacks or threaded replies.
  // Spectrum warns and skips `message.react` / `message.reply` here, resolving
  // them with `undefined`. Local mode also has no typing API, so
  // `space.responding` runs the callback without a typing bubble. Reply with a
  // fresh send.
  const answer = await space.responding(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return `echo: ${incoming}`;
  });

  await space.send(text(answer));
}
