// Shared, wired-but-headless chat-SDK bot used by every script in this folder.
// "Headless" = adapters + state configured, but NO message handlers, since
// Spectrum becomes the handler (your logic lives in the `app.messages` loop).
// Interaction handlers (onSlashCommand/onAction) are fine to add on top — see
// slash-commands.ts.
//
// Credentials are auto-detected from the environment (Bun loads `.env`):
//   DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID
// and "Message Content Intent" must be ON in the Discord Developer Portal.

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

// The map key MUST equal the adapter's name ("discord") — thread ids are
// prefixed `discord:…` and resolved by that key.
export const createBot = () =>
  new Chat({
    userName: "spectrum-bot",
    adapters: { discord: createDiscordAdapter() },
    state: createMemoryState(),
  });
