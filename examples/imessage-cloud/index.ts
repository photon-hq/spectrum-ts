import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Minimal cloud iMessage echo bot.
//
// Credentials are read from the environment:
//   SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET
// Create a project and an iMessage line at https://photon.codes, then run:
//   SPECTRUM_PROJECT_ID=... SPECTRUM_PROJECT_SECRET=... bun run index.ts
//
// You can also pass them explicitly instead of via env:
//   Spectrum({ projectId, projectSecret, providers: [imessage.config()] })
//
// `providers:` is the v12 shape — the old `platforms:` key was removed.
const app = await Spectrum({
  providers: [imessage.config()],
});

console.log("iMessage bot listening — text the bot's line to try it.");

for await (const [space, message] of app.messages) {
  // Only handle inbound text. Skip our own sends (direction "outbound") and
  // non-text content (reactions, attachments, effects, …).
  if (message.direction === "outbound" || message.content.type !== "text") {
    continue;
  }

  const incoming = message.content.text;

  // Acknowledge with a tapback. `message.react` resolves to the reaction
  // Message — keep it if you want to `unsend()` the tapback later.
  await message.react("👀");

  // Show a typing indicator for the duration of the async work. `responding`
  // starts typing, runs the callback, and stops typing when it settles — so
  // the bubble is visible while a real agent/LLM call is in flight.
  const answer = await space.responding(async () => {
    // Replace this with real work; we just pause, then echo.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return `echo: ${incoming}`;
  });

  // `message.reply` threads the response to the incoming message.
  await message.reply(text(answer));
}
