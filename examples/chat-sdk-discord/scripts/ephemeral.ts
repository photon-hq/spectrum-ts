// Ephemeral (only-you-can-see-it) message via the live thread escape hatch.
//
// `chatThread(space)` returns the live chat-SDK Thread backing the inbound
// conversation — your door to native, per-conversation calls Spectrum doesn't
// model: postEphemeral, openModal, subscribe, history, etc.
//
// Run: bun run ephemeral.ts  (then @-mention or DM the bot)

import { Spectrum } from "spectrum-ts";
import { chatSDK, chatThread } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text" || !message.sender) {
    continue;
  }

  const thread = chatThread(space);
  if (!thread) {
    continue;
  }

  // Visible only to the sender; falls back to a DM if the platform/context
  // doesn't support native ephemerals.
  await thread.postEphemeral(
    message.sender.id,
    { markdown: `🤫 psst — you said: ${message.content.text}` },
    { fallbackToDM: true }
  );
}
