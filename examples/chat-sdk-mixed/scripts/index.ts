// Two platforms, one loop. Discord and Linear arrive merged in `app.messages`;
// `discord.is()` / `linear.is()` branch type-safely (no `space.id` sniffing) so
// each gets behavior that fits — Discord chatty, Linear terse issue-triage.
//
// Delivery differs: Discord over the Gateway (auto), Linear over a webhook you
// serve. Expose :3000 with a tunnel and register it as your Linear webhook
// (`https://<tunnel>/webhooks/linear`).
//
// Run: bun echo

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createLinearAdapter } from "@chat-adapter/linear";
import { Spectrum } from "spectrum-ts";
import { chatSDK, messageMeta } from "spectrum-ts/providers/chat-sdk";

// One narrowable platform per adapter — name inferred from each adapter.
const discord = chatSDK(createDiscordAdapter());
const linear = chatSDK(createLinearAdapter());

const app = await Spectrum({
  providers: [
    discord.config({ userName: "spectrum-bot" }),
    linear.config({ userName: "spectrum-bot" }),
  ],
});

// Serve the Linear webhook ourselves — only Gateway adapters (Discord) auto-pump.
Bun.serve({
  port: 3000,
  routes: { "/webhooks/linear": { POST: linear(app).webhook } },
});
console.log("listening for Linear webhooks on :3000/webhooks/linear");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }
  const text = message.content.text;

  if (discord.is(message)) {
    // `messageMeta` reads the typed Discord extras. Stay quiet unless addressed.
    const { isMention, edited, links } = messageMeta(message);
    if (!isMention) {
      continue;
    }

    await space.send(
      `Hey! You said: "${text}"${edited ? " (caught your edit 👀)" : ""}`
    );
    if (links.length > 0) {
      const titles = links.map((link) => link.title ?? link.url).join(", ");
      await space.send(`Nice link${links.length > 1 ? "s" : ""}: ${titles}`);
    }
    continue;
  }

  if (linear.is(message)) {
    const { edited } = messageMeta(message);
    await space.send(
      `Noted${edited ? " (updated)" : ""}: "${text}". I'll track this — reply with ` +
        "`status`, `owner`, or `next steps` and I'll help move it along."
    );
  }
}
