// Ephemeral (only-you-see-it) message via the live-thread escape hatch.
// `chatThread(space)` returns the chat-SDK Thread behind the conversation — your
// door to native calls Spectrum doesn't model (postEphemeral, openModal, …).
//
// Run: bun ephemeral  (then @-mention or DM the bot)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { Spectrum } from "spectrum-ts";
import { chatSDK, chatThread } from "spectrum-ts/providers/chat-sdk";

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text" || !message.sender) {
    continue;
  }

  const thread = chatThread(space);
  if (!thread) {
    continue;
  }

  // Visible only to the sender; falls back to a DM where native ephemerals aren't supported.
  await thread.postEphemeral(
    message.sender.id,
    { markdown: `🤫 psst — you said: ${message.content.text}` },
    { fallbackToDM: true }
  );
}
