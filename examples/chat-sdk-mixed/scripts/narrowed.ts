// Platform narrowing across two chat-SDK adapters. Each `chatSDK(adapter)` is its
// own narrowable platform (name inferred from the adapter), exactly like the
// native `imessage`/`telegram` providers — the platform identity is the
// discriminator, type-safe, no string keys. The SAME const both registers
// (`discord.config()`) and narrows (`discord.is`, `discord(app)`).
//
// Below: four consumption styles, agnostic → fully narrowed. The file runs (A);
// (B)–(D) are commented alternatives — pick ONE in a real script.
//
// Run: bun narrowed

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createLinearAdapter } from "@chat-adapter/linear";
import { Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

const discord = chatSDK(createDiscordAdapter());
const linear = chatSDK(createLinearAdapter());

// `.config()` is argless: host config is all-optional (credentials live in the
// adapter). Here we set a userName for both.
const app = await Spectrum({
  providers: [
    discord.config({ userName: "spectrum-bot" }),
    linear.config({ userName: "spectrum-bot" }),
  ],
});

// Webhook serving lives on the narrowed instance. Linear is webhook-delivered;
// Discord is Gateway-delivered and auto-pumped, so it needs no route.
Bun.serve({
  port: 3000,
  routes: { "/webhooks/linear": { POST: linear(app).webhook } },
});
console.log("listening for Linear webhooks on :3000/webhooks/linear");

// (A) AGNOSTIC — one loop, never branches on platform. The 99% path.
for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(`Echo: ${message.content.text}`);
  }
}

// (B) UNIFIED LOOP + `is()` GUARDS — `discord.is(message)` narrows in place, so
//     `.isMention`/`.edited`/`.links` are typed with no cast.
//
//     for await (const [space, message] of app.messages) {
//       if (message.content.type !== "text") continue;
//       if (discord.is(message)) {
//         if (message.isMention) await space.send("you @-mentioned me on Discord");
//       } else if (linear.is(message)) {
//         await space.send(`tracked${message.edited ? " (edited)" : ""}`);
//       }
//     }

// (C) PER-PLATFORM NARROWED STREAMS — `discord(app).messages` yields tuples
//     already typed as `[PlatformSpace<"discord">, ChatSdkMessage<"discord">]`.
//     Best when the two platforms want genuinely different logic.
//
//     await Promise.all([
//       (async () => {
//         for await (const [space, message] of discord(app).messages)
//           if (message.isMention) await space.send("(discord) hi");
//       })(),
//       (async () => {
//         for await (const [space] of linear(app).messages) await space.send("(linear) tracked");
//       })(),
//     ]);

// (D) EXPLICIT NARROWING — when you hold a value TS sees as generic and know its
//     platform: `discord(message)` / `discord(space)` narrow on demand;
//     `discord(app)` gives the typed instance (`await discord(app).user("123…")`).
