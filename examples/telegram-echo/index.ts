/**
 * Telegram Echo — cross-platform Spectrum example using Telegram as the provider.
 *
 * Uses only Spectrum's universal APIs (send, reply, edit, typing) — the same
 * code works with any provider by swapping the config line.
 *
 * Setup:
 *   1. Message @BotFather on Telegram, send /newbot, follow the prompts
 *   2. Copy the token and set TELEGRAM_BOT_TOKEN in your environment
 *   3. Run: bun run start
 *   4. DM your bot — try sending text, or "edit" / "typing" to see those features
 */

import { Spectrum, text } from "spectrum-ts";
import { telegram } from "spectrum-ts/providers/telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("Set TELEGRAM_BOT_TOKEN first — see comment above");
}

const app = await Spectrum({
  providers: [telegram.config({ token })],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  const input = message.content.text.trim().toLowerCase();

  if (input === "edit") {
    const sent = await space.send(text("This message will be edited..."));
    await sent.edit(
      "Edited! The OutboundMessage.edit() API works on any provider."
    );
    continue;
  }

  if (input === "typing") {
    await space.startTyping();
    await new Promise((r) => setTimeout(r, 2000));
    await space.send(text("Done typing!"));
    continue;
  }

  await message.reply(text(`echo: ${message.content.text}`));
}
